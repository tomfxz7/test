"""Browser integration tests: python3 scheduleapp/tests/test_progress.py

Requires Python Playwright and Chromium. Downloads pinned official UMD assets via
jsDelivr with normal TLS verification. Uses real React/Babel/lucide and a Tailwind
browser runtime to supply the host application's utility styles; no npm build or
application source rewriting on disk is required. Browser requests are fulfilled
locally after the assets are downloaded, and each test gets isolated IndexedDB.
"""
import json
import re
import shutil
import tempfile
from urllib.request import urlopen
import unittest
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

TODAY = datetime.now(ZoneInfo('Asia/Tokyo')).date()
FUTURE_DAY = TODAY + timedelta(days=5)
while FUTURE_DAY.weekday() > 4:
    FUTURE_DAY += timedelta(days=1)
FUTURE = FUTURE_DAY.isoformat()
LATER_DAY = TODAY + timedelta(days=12)
while LATER_DAY.weekday() > 4:
    LATER_DAY += timedelta(days=1)
LATER = LATER_DAY.isoformat()
PAST = (TODAY - timedelta(days=1)).isoformat()

def task(id='track', **extra):
    return dict(id=id, title='進捗テスト案件' if id == 'track' else '対象外タスク',
                type='simple', date=(TODAY if TODAY.weekday() < 5 else TODAY + timedelta(days=7-TODAY.weekday())).isoformat(), dueDate=FUTURE,
                memo='',urls=[],completed=False,order=1,subtasks=[
                    dict(id='s1',title='既存の調査',dueDate=FUTURE,completed=False),
                    dict(id='s2',title='期限切れの確認',dueDate=PAST,completed=False)], **extra)

class ProgressTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.assets = tempfile.TemporaryDirectory(prefix='schedule-progress-assets-')
        dependencies = {
            'react.js': 'react@18.3.1/umd/react.development.js',
            'react-dom.js': 'react-dom@18.3.1/umd/react-dom.development.js',
            'babel.js': '@babel/standalone@7.26.9/babel.min.js',
            'icons.js': 'lucide-react@0.468.0/dist/umd/lucide-react.js',
            'tailwind.js': '@tailwindcss/browser@4.1.18/dist/index.global.js',
        }
        for name, package in dependencies.items():
            with urlopen('https://cdn.jsdelivr.net/npm/' + package, timeout=30) as response:
                Path(cls.assets.name, name).write_bytes(response.read())
        source = Path(__file__).resolve().parents[1].joinpath('schedule.jsx').read_text()
        source = re.sub(r"import React, \{([^}]+)\} from 'react';", r'const {\1} = React;', source)
        source = re.sub(r"import \{([^}]+)\} from 'lucide-react';", lambda match: 'const {' + match[1].replace(' as ', ': ') + '} = window.LucideReact;', source)
        source = source.replace('export default function App()', 'function App()')
        cls.source = source + "\nReactDOM.createRoot(document.getElementById('root')).render(<App/>);"
        cls.html = '''<!DOCTYPE html><html lang="ja"><meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <script src="/react.js"></script><script>window.react=window.React;</script>
        <script src="/react-dom.js"></script><script src="/icons.js"></script>
        <script src="/tailwind.js"></script><script src="/babel.js"></script>
        <div id="root"></div><script type="text/babel" data-presets="react" src="/app.jsx"></script></html>'''
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(executable_path=shutil.which('chromium'),args=['--no-sandbox'])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.assets.cleanup()

    def setUp(self):
        self.ctx = self.browser.new_context(viewport={'width':1600,'height':1100}, timezone_id='Asia/Tokyo')
        self.page = self.ctx.new_page()
        self.errors = []
        self.page.on('pageerror',lambda e:self.errors.append(str(e)))
        self.page.route('https://schedule.test/**', self.route)
        self.page.goto('https://schedule.test/')
        expect(self.page.get_by_role('heading',name='TaskMatrix Pro')).to_be_visible()

    def route(self, route):
        name = route.request.url.split('/')[-1]
        if name == '':
            route.fulfill(body=self.html, content_type='text/html')
        elif name == 'app.jsx':
            route.fulfill(body=self.source, content_type='application/javascript')
        else:
            asset = Path(self.assets.name, name)
            if asset.is_file():
                route.fulfill(path=asset, content_type='application/javascript')
            else:
                route.fulfill(status=404, body='Not found')

    def tearDown(self):
        self.ctx.close()
        self.assertEqual(self.errors,[])

    def seed(self,tasks):
        self.page.evaluate('''async tasks => {
          const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('TaskMatrixAppDB',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
          await new Promise((resolve,reject)=>{const tx=db.transaction('appData','readwrite');const s=tx.objectStore('appData');s.put(tasks,'tasks');s.put([],'recurringSchedules');s.put([],'projects');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)});db.close();
        }''',tasks)
        self.page.reload()
        expect(self.page.get_by_role('heading',name='TaskMatrix Pro')).to_be_visible()

    def stored(self):
        return self.page.evaluate('''async()=>{const db=await new Promise(r=>{const q=indexedDB.open('TaskMatrixAppDB',1);q.onsuccess=()=>r(q.result)});return await new Promise(r=>{const q=db.transaction('appData').objectStore('appData').get('tasks');q.onsuccess=()=>{r(JSON.parse(JSON.stringify(q.result)));db.close()}})}''')

    def progress(self):
        self.page.get_by_role('button',name='進捗',exact=True).click()

    def card(self,id='track'):
        return self.page.locator('[data-progress-task-id="'+id+'"]')

    def select_chat(self):
        self.card().get_by_role('button',name='進捗テスト案件',exact=True).click()

    def send(self,text):
        box=self.page.get_by_label('進捗コメント',exact=True)
        box.fill(text);box.press('Control+Enter')
        expect(box).to_have_value('')

    def test_board_selection_drag_and_shared_subtasks(self):
        self.seed([task(),task('other')])
        self.progress()
        expect(self.card()).to_have_count(0)
        self.page.get_by_role('button',name='ボード',exact=True).click()
        board_card=self.page.locator('#task-track')
        board_card.locator('input[type=checkbox]').check()
        self.progress()
        expect(self.card()).to_be_visible()
        expect(self.card('other')).to_have_count(0)
        self.card().drag_to(self.page.locator('[data-progress-stage="doing"]'))
        dialog=self.page.get_by_role('dialog',name='進捗の設定')
        expect(dialog).to_be_visible()
        dialog.get_by_role('button',name='キャンセル',exact=True).click()
        expect(self.page.locator('[data-progress-stage="todo"]').locator('[data-progress-task-id="track"]')).to_be_visible()
        self.card().drag_to(self.page.locator('[data-progress-stage="doing"]'))
        expect(dialog).to_be_visible()
        expect(dialog.get_by_label('やるべきこと 1',exact=True)).to_have_value('既存の調査')
        dialog.get_by_label('新しいやるべきこと',exact=True).fill('Enterで追加した調整')
        dialog.get_by_label('新しいやるべきこと',exact=True).press('Enter')
        expect(dialog.get_by_label('やるべきこと 3',exact=True)).to_have_value('Enterで追加した調整')
        expect(dialog.get_by_label('やるべきこと 3 の期限',exact=True)).to_have_value(FUTURE)
        dialog.get_by_label('やるべきこと 3',exact=True).press('Control+Enter')
        expect(dialog).to_have_count(0)
        expect(self.page.locator('[data-progress-stage="doing"]').locator('[data-progress-task-id="track"]')).to_be_visible()
        data=self.stored()[0]
        self.assertEqual(data['progressStage'],'doing')
        self.assertEqual(data['subtasks'][-1]['dueDate'],FUTURE)
        self.page.get_by_role('button',name='ボード',exact=True).click()
        expect(self.page.get_by_text('Enterで追加した調整',exact=True)).to_be_visible()

    def test_chat_status_completion_deadline_history_and_persistence(self):
        self.seed([task(progressEnabled=True,progressStage='doing')])
        self.progress(); self.select_chat()
        complete=self.page.get_by_label('完了',exact=True)
        expect(complete).to_be_disabled()
        self.page.get_by_label('関連: 既存の調査',exact=True).check()
        expect(complete).to_be_enabled()
        self.page.get_by_label('相手待ち',exact=True).check()
        self.send('担当者に確認を依頼')
        data=self.stored()[0]
        self.assertTrue(data['subtasks'][0]['waiting'])
        self.assertFalse(data.get('waiting',False))
        self.assertIn('bg-blue-50', self.card().get_attribute('class'))
        self.page.get_by_label('関連: 既存の調査',exact=True).check()
        complete.check()
        self.send('確認が完了しました')
        self.assertTrue(self.stored()[0]['subtasks'][0]['completed'])
        self.page.get_by_label('やるべきことの追加',exact=True).check()
        self.send('追加で資料を作成')
        self.assertEqual(self.stored()[0]['subtasks'][-1]['title'],'追加で資料を作成')
        self.assertEqual(self.stored()[0]['subtasks'][-1]['dueDate'],FUTURE)
        self.page.get_by_label('相手待ち',exact=True).check()
        self.send('全体の回答待ち')
        self.assertTrue(self.stored()[0]['waiting'])
        self.assertIn('bg-green-50',self.card().get_attribute('class'))
        self.card().get_by_role('button',name='進捗テスト案件の設定',exact=True).click()
        dialog=self.page.get_by_role('dialog',name='進捗の設定')
        dialog.get_by_label('タスクの期限',exact=True).fill(LATER)
        dialog.get_by_label('やるべきこと 3 の期限',exact=True).fill(LATER)
        dialog.get_by_label('変更理由',exact=True).fill('顧客の回答日が変更されたため')
        dialog.get_by_role('button',name='確定',exact=True).click()
        history=self.stored()[0]['progressHistory']
        self.assertTrue(any('顧客の回答日が変更されたため' in m['text'] for m in history))
        self.assertTrue(any(FUTURE in m['text'] and LATER in m['text'] for m in history))
        self.page.get_by_label('履歴を検索',exact=True).fill('担当者に確認を依頼')
        expect(self.page.get_by_text('担当者に確認を依頼',exact=True)).to_be_visible()
        expect(self.page.get_by_text('全体の回答待ち',exact=True)).to_have_count(0)
        self.page.get_by_label('履歴を検索',exact=True).fill('')
        self.page.get_by_label('やるべきことで絞り込み',exact=True).select_option('s1')
        expect(self.page.get_by_text('担当者に確認を依頼',exact=True)).to_be_visible()
        expect(self.page.get_by_text('全体の回答待ち',exact=True)).to_have_count(0)
        self.page.reload();self.progress();self.select_chat()
        expect(self.page.get_by_text('全体の回答待ち',exact=True)).to_be_visible()
        with self.page.expect_download() as d:
            self.page.get_by_role('button',name='エクスポート',exact=True).click()
        saved=json.loads(Path(d.value.path()).read_text())
        self.assertEqual(saved['tasks'][0]['progressHistory'],self.stored()[0]['progressHistory'])

    def test_other_page_edit_is_audited_and_tracking_toggle_keeps_history(self):
        self.seed([task(progressEnabled=True,progressStage='doing',progressHistory=[dict(id='history1',kind='comment',createdAt='2026-01-01T01:00:00.000Z',text='保持するコメント',subtaskIds=[],subtaskTitles=[])])])
        card=self.page.locator('#task-track')
        card.get_by_role('button',name='編集',exact=True).click()
        self.page.locator('form input[type=date]').first.fill(LATER)
        self.page.get_by_role('button',name='保存する',exact=True).click()
        self.progress();self.select_chat()
        expect(self.page.get_by_text('保持するコメント',exact=True)).to_be_visible()
        self.assertTrue(any(FUTURE in m['text'] and LATER in m['text'] for m in self.stored()[0]['progressHistory']))
        self.page.get_by_role('button',name='ボード',exact=True).click()
        self.page.locator('#task-track input[type=checkbox]').uncheck()
        self.progress();expect(self.card()).to_have_count(0)
        self.assertEqual(len(self.stored()),1)
        self.page.get_by_role('button',name='ボード',exact=True).click()
        self.page.locator('#task-track input[type=checkbox]').check()
        self.progress()
        self.card().get_by_role('button',name='着手する',exact=True).click()
        self.page.get_by_role('dialog',name='進捗の設定').get_by_role('button',name='確定',exact=True).click()
        expect(self.page.get_by_text('保持するコメント',exact=True)).to_be_visible()

    def test_existing_task_modal_cancel_does_not_mutate_subtasks(self):
        self.seed([task(progressEnabled=True,progressStage='doing')])
        before=self.stored()
        self.page.locator('#task-track').get_by_role('button',name='編集',exact=True).click()
        self.page.get_by_placeholder('サブタスク名',exact=True).first.fill('キャンセルする変更')
        self.page.locator('form input[type=date]').nth(1).fill(LATER)
        self.page.get_by_role('button',name='キャンセル',exact=True).click()
        self.assertEqual(self.stored(),before)
        self.progress()
        expect(self.card().get_by_text('既存の調査',exact=True)).to_be_visible()
        expect(self.card().get_by_text('キャンセルする変更',exact=True)).to_have_count(0)

    def test_composer_can_send_at_short_and_mobile_viewports(self):
        self.seed([task(progressEnabled=True,progressStage='doing')])
        for width,height in [(1366,768),(1366,720),(390,844)]:
            with self.subTest(viewport=(width,height)):
                self.page.set_viewport_size({'width':width,'height':height})
                self.progress();self.select_chat()
                self.page.get_by_label('進捗コメント',exact=True).fill(f'{width}x{height}から送信')
                send=self.page.get_by_role('button',name='送信',exact=True)
                send.scroll_into_view_if_needed()
                bounds=send.bounding_box()
                self.assertGreaterEqual(bounds['y'],0)
                self.assertLessEqual(bounds['y']+bounds['height'],height)
                send.click()
                self.assertTrue(any(m['text']==f'{width}x{height}から送信' for m in self.stored()[0]['progressHistory']))

    def test_progress_creation_appears_on_board(self):
        self.seed([]);self.progress()
        self.page.get_by_role('button',name='未着手タスクを追加',exact=True).click()
        self.page.get_by_placeholder('タスク名を入力',exact=True).fill('進捗から作成した案件')
        self.page.locator('form input[type=date]').fill((TODAY if TODAY.weekday() < 5 else TODAY + timedelta(days=7-TODAY.weekday())).isoformat())
        self.page.get_by_role('button',name='登録する',exact=True).click()
        expect(self.page.get_by_text('進捗から作成した案件',exact=True)).to_be_visible()
        self.assertTrue(self.stored()[0]['progressEnabled'])
        self.page.get_by_role('button',name='ボード',exact=True).click()
        expect(self.page.get_by_text('進捗から作成した案件',exact=True)).to_be_visible()

if __name__=='__main__':unittest.main(verbosity=2)
