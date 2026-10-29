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

    def entry(self,entry_id):
        return self.page.locator('[data-progress-entry-id="'+entry_id+'"]')

    def reply(self,entry_id):
        self.entry(entry_id).get_by_role('button',name='コメントに返信',exact=True).click()
        expect(self.page.get_by_role('region',name='返信先',exact=True)).to_be_visible()

    def test_waiting_comments_share_small_task_list_and_resolve_by_reply(self):
        source=dict(id='integrated-wait',kind='comment',createdAt='2026-01-01T01:00:00.000Z',
                    text='資料の回答待ち',status='waiting',subtaskIds=['s1'],subtaskTitles=['既存の調査'])
        original=task(progressEnabled=True,progressStage='doing',progressHistory=[source])
        original['subtasks'][0].update(waiting=True,smallTasks=[dict(id='small1',title='既存の小さい作業',completed=False)])
        self.seed([original]);self.progress();self.select_chat()
        row=self.page.locator('[data-progress-waiting-task-id="integrated-wait"]')
        expect(row).to_have_count(0)
        self.page.get_by_role('button',name='既存の調査の小さいタスクを展開',exact=True).click()
        expect(row).to_be_visible()
        expect(row).to_have_class(re.compile(r'\bbg-green-50\b'))
        expect(self.page.locator('[data-progress-small-task-id="small1"]')).to_be_visible()
        self.assertEqual(self.stored()[0],original)
        row.get_by_role('button',name='資料の回答待ちに返信',exact=True).click()
        expect(self.page.get_by_role('region',name='返信先',exact=True)).to_be_visible()
        self.send('回答を受領しました')
        expect(row).to_have_count(0)
        result=self.stored()[0]
        self.assertFalse(result['subtasks'][0]['waiting'])
        self.assertEqual(result['subtasks'][0]['smallTasks'],original['subtasks'][0]['smallTasks'])
        self.assertEqual(result['progressHistory'][0]['quote']['id'],source['id'])
        expect(self.entry(result['progressHistory'][0]['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))
        self.page.reload();self.progress();self.select_chat()
        expect(row).to_have_count(0)

    def test_task_level_waiting_is_visible_without_duplicate_nested_waiting(self):
        entries=[dict(id='global-wait',kind='comment',text='タスク全体の回答待ち',status='waiting',subtaskIds=[],subtaskTitles=[]),
                 dict(id='nested-wait',kind='comment',text='小さい作業の回答待ち',status='waiting',subtaskIds=['s1'],subtaskTitles=['既存の調査'],smallTaskId='small1',smallTaskTitle='小さい作業')]
        for entry in entries: entry['createdAt']='2026-01-01T01:00:00.000Z'
        original=task(progressEnabled=True,progressStage='doing',waiting=True,progressHistory=entries)
        original['subtasks'][0]['smallTasks']=[dict(id='small1',title='小さい作業',waiting=True,completed=False)]
        self.seed([original]);self.progress();self.select_chat()
        expect(self.page.locator('[data-progress-waiting-task-id="global-wait"]')).to_be_visible()
        self.page.get_by_role('button',name='既存の調査の小さいタスクを展開',exact=True).click()
        expect(self.page.locator('[data-progress-small-task-id="small1"]')).to_have_count(1)
        expect(self.page.locator('[data-progress-waiting-task-id="nested-wait"]')).to_have_count(0)
        self.assertEqual(self.stored()[0],original)
        row=self.page.locator('[data-progress-waiting-task-id="global-wait"]')
        row.get_by_role('button',name='タスク全体の回答待ちに返信',exact=True).click()
        expect(self.page.get_by_role('region',name='返信先',exact=True)).to_be_visible()
        row.get_by_role('button',name='タスク全体の回答待ちの相手待ちを削除',exact=True).click()
        expect(row).to_have_count(0)
        expect(self.page.get_by_role('region',name='返信先',exact=True)).to_have_count(0)
        self.assertTrue(self.stored()[0]['waiting'])
        self.assertEqual(self.stored()[0]['subtasks'],original['subtasks'])

    def test_ordinary_reply_keeps_source_and_immutable_quote(self):
        source=dict(id='reply-source',kind='comment',createdAt='2026-01-01T01:00:00.000Z',
                    text='引用する最初の進捗',status='active',subtaskIds=['s1'],subtaskTitles=['既存の調査'])
        self.seed([task(progressEnabled=True,progressStage='doing',progressHistory=[source])])
        self.progress();self.select_chat();self.reply(source['id'])
        expect(self.page.get_by_label('関連: 既存の調査',exact=True)).to_be_checked()
        self.send('引用への補足回答')
        history=self.stored()[0]['progressHistory']
        self.assertEqual(len(history),2)
        self.assertEqual(history[0],source)
        message=history[1]
        self.assertEqual(message['quote']['id'],source['id'])
        self.assertEqual(message['quote']['text'],source['text'])
        self.assertEqual(message['quote']['createdAt'],source['createdAt'])
        self.assertEqual(message['subtaskIds'],['s1'])
        expect(self.entry(message['id']).get_by_role('blockquote',name='引用コメント')).to_contain_text(source['text'])
        self.entry(source['id']).get_by_role('button',name='コメントを編集',exact=True).click()
        self.page.get_by_label('コメントの編集',exact=True).fill('引用後に変更した元の記録')
        self.page.get_by_role('button',name='編集を保存',exact=True).click()
        self.assertEqual(self.stored()[0]['progressHistory'][1]['quote']['text'],source['text'])
        self.page.get_by_label('履歴を検索',exact=True).fill(source['text'])
        expect(self.entry(message['id'])).to_be_visible()
        expect(self.entry(source['id'])).to_have_count(0)
        self.page.get_by_label('やるべきことで絞り込み',exact=True).select_option('s1')
        expect(self.entry(message['id'])).to_be_visible()

    def test_waiting_reply_replaces_source_and_roundtrips_blue(self):
        source=dict(id='waiting-source',kind='comment',createdAt='2026-01-01T01:00:00.000Z',
                    text='顧客からの回答を待っています',status='waiting',subtaskIds=[],subtaskTitles=[])
        self.seed([task(progressEnabled=True,progressStage='doing',waiting=True,progressHistory=[source])])
        self.progress();self.select_chat();self.reply(source['id'])
        expect(self.page.get_by_label('相手待ち',exact=True)).not_to_be_checked()
        self.send('回答を受領し再開しました')
        stored=self.stored()[0]
        self.assertEqual(len(stored['progressHistory']),1)
        self.assertFalse(stored['waiting'])
        message=stored['progressHistory'][0]
        self.assertNotEqual(message['id'],source['id'])
        self.assertEqual(message['quote']['text'],source['text'])
        self.assertEqual(message['quote']['status'],'waiting')
        expect(self.entry(source['id'])).to_have_count(0)
        expect(self.entry(message['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))
        self.entry(message['id']).get_by_role('button',name='コメントを編集',exact=True).click()
        self.page.get_by_label('コメントの編集',exact=True).fill('受領した回答の補足を記録')
        self.page.get_by_role('button',name='編集を保存',exact=True).click()
        edited=self.stored()[0]['progressHistory'][0]
        self.assertEqual(edited['quote'],message['quote'])
        self.assertEqual(edited['id'],message['id'])
        self.assertFalse(self.stored()[0]['waiting'])
        self.page.reload();self.progress();self.select_chat()
        expect(self.entry(message['id'])).to_contain_text(source['text'])
        expect(self.entry(message['id'])).to_contain_text('受領した回答の補足を記録')
        expect(self.entry(message['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))
        with self.page.expect_download() as download:
            self.page.get_by_role('button',name='エクスポート',exact=True).click()
        saved=json.loads(Path(download.value.path()).read_text())
        self.assertEqual(saved['tasks'][0]['progressHistory'],self.stored()[0]['progressHistory'])

    def test_reply_cancel_empty_and_composition_do_not_remove_source(self):
        source=dict(id='unanswered',kind='comment',createdAt='2026-01-01T01:00:00.000Z',
                    text='削除しない回答待ち',status='waiting',subtaskIds=[],subtaskTitles=[])
        self.seed([task(progressEnabled=True,progressStage='doing',waiting=True,progressHistory=[source])])
        self.progress();self.select_chat();self.reply(source['id'])
        expect(self.page.get_by_label('やるべきことの追加',exact=True)).to_be_disabled()
        expect(self.page.get_by_label('小さいタスクの追加',exact=True)).to_be_disabled()
        editor=self.page.get_by_label('進捗コメント',exact=True)
        editor.fill('  ')
        expect(self.page.get_by_role('button',name='送信',exact=True)).to_be_disabled()
        editor.press('Control+Enter')
        self.assertEqual(self.stored()[0]['progressHistory'],[source])
        editor.fill('変換中の返信')
        editor.evaluate("el => el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,isComposing:true,bubbles:true,cancelable:true}))")
        self.assertEqual(self.stored()[0]['progressHistory'],[source])
        self.page.get_by_role('button',name='返信をキャンセル',exact=True).click()
        expect(self.page.get_by_role('region',name='返信先',exact=True)).to_have_count(0)
        expect(self.entry(source['id'])).to_be_visible()
        self.assertEqual(self.stored()[0]['progressHistory'],[source])
        self.assertTrue(self.stored()[0]['waiting'])

    def test_nested_waiting_reply_is_blue_and_only_resolves_small_task(self):
        source=dict(id='small-wait',kind='comment',createdAt='2026-01-01T01:00:00.000Z',
                    text='小さい作業の回答を待っています',status='waiting',subtaskIds=['s1'],subtaskTitles=['既存の調査'],
                    smallTaskId='small1',smallTaskTitle='資料の数字を確認')
        original=task(progressEnabled=True,progressStage='doing',waiting=True,progressHistory=[source])
        original['subtasks'][0]['waiting']=True
        original['subtasks'][0]['smallTasks']=[dict(id='small1',title='資料の数字を確認',waiting=True,completed=False)]
        self.seed([original]);self.progress();self.select_chat();self.reply(source['id'])
        expect(self.page.get_by_label('関連: 既存の調査',exact=True)).to_be_checked()
        self.send('数字の回答を受領')
        stored=self.stored()[0]
        self.assertEqual(len(stored['progressHistory']),1)
        message=stored['progressHistory'][0]
        self.assertEqual(message['smallTaskId'],'small1')
        self.assertEqual(message['subtaskIds'],['s1'])
        self.assertEqual(message['quote']['smallTaskTitle'],'資料の数字を確認')
        self.assertFalse(stored['subtasks'][0]['smallTasks'][0]['waiting'])
        self.assertTrue(stored['subtasks'][0]['waiting'])
        self.assertTrue(stored['waiting'])
        expect(self.entry(message['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))
        self.page.get_by_label('やるべきことで絞り込み',exact=True).select_option('s1')
        expect(self.entry(message['id'])).to_be_visible()

    def test_reply_to_deleted_small_target_preserves_refs_without_parent_status_write(self):
        source=dict(id='deleted-small-wait',kind='comment',createdAt='2026-01-01T01:00:00.000Z',
                    text='削除した小さい項目への回答待ち',status='waiting',subtaskIds=['s1'],subtaskTitles=['既存の調査'],
                    smallTaskId='removed-small',smallTaskTitle='削除した確認項目')
        original=task(progressEnabled=True,progressStage='doing',waiting=True,progressHistory=[source])
        original['subtasks'][0]['waiting']=True
        self.seed([original]);self.progress();self.select_chat();self.reply(source['id'])
        self.send('削除済み項目について回答を補足')
        stored=self.stored()[0]
        self.assertEqual(len(stored['progressHistory']),1)
        message=stored['progressHistory'][0]
        self.assertNotEqual(message['id'],source['id'])
        self.assertEqual(message['smallTaskId'],'removed-small')
        self.assertEqual(message['quote']['id'],source['id'])
        self.assertEqual(message['subtaskIds'],['s1'])
        self.assertTrue(stored['subtasks'][0]['waiting'])
        self.assertTrue(stored['waiting'])
        expect(self.entry(message['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))

    def test_reply_to_deleted_todo_keeps_historical_parent_filter(self):
        source=dict(id='deleted-todo-wait',kind='comment',createdAt='2026-01-01T01:00:00.000Z',
                    text='削除されたやるべきことの回答待ち',status='waiting',subtaskIds=['removed-todo'],subtaskTitles=['以前の確認項目'])
        self.seed([task(progressEnabled=True,progressStage='doing',waiting=True,progressHistory=[source])])
        self.progress();self.select_chat();self.reply(source['id'])
        self.send('削除済みの確認項目への回答')
        stored=self.stored()[0]
        self.assertEqual(len(stored['progressHistory']),1)
        message=stored['progressHistory'][0]
        self.assertEqual(message['subtaskIds'],['removed-todo'])
        self.assertEqual(message['subtaskTitles'],['以前の確認項目'])
        self.assertEqual(message['quote']['subtaskIds'],['removed-todo'])
        self.assertTrue(stored['waiting'])
        expect(self.entry(source['id'])).to_have_count(0)
        self.page.get_by_label('やるべきことで絞り込み',exact=True).select_option('removed-todo')
        expect(self.entry(message['id'])).to_be_visible()
        expect(self.entry(message['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))

    def test_replies_preserve_quote_chain_when_waiting_sources_are_replaced(self):
        source=dict(id='chain-start',kind='comment',createdAt='2026-01-01T01:00:00.000Z',
                    text='最初の回答依頼',status='waiting',subtaskIds=[],subtaskTitles=[])
        self.seed([task(progressEnabled=True,progressStage='doing',waiting=True,progressHistory=[source])])
        self.progress();self.select_chat();self.reply(source['id'])
        self.page.get_by_label('相手待ち',exact=True).check()
        self.send('追加の回答を依頼しました')
        first=self.stored()[0]['progressHistory'][0]
        expect(self.entry(first['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-green-50\b'))
        self.reply(first['id']);self.send('すべての回答を受領しました')
        history=self.stored()[0]['progressHistory']
        self.assertEqual(len(history),1)
        final=history[0]
        self.assertEqual(final['quote']['id'],first['id'])
        self.assertEqual(final['quote']['quote']['id'],source['id'])
        self.assertEqual(final['quote']['quote']['text'],source['text'])
        expect(self.entry(final['id'])).to_contain_text(source['text'])
        expect(self.entry(final['id'])).to_contain_text('追加の回答を依頼しました')
        expect(self.entry(final['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))

    def test_nested_small_task_addition_requires_one_todo_and_no_deadline(self):
        original=task(progressEnabled=True,progressStage='doing',waiting=True)
        original['subtasks'][0]['waiting']=True
        self.seed([original]);self.progress();self.select_chat()
        self.page.get_by_label('小さいタスクの追加',exact=True).check()
        box=self.page.get_by_label('進捗コメント',exact=True)
        box.fill('資料の目次を作成')
        send=self.page.get_by_role('button',name='送信',exact=True)
        expect(send).to_be_disabled()
        expect(self.page.get_by_label('追加するやるべきことの期限',exact=True)).to_have_count(0)
        self.page.get_by_label('関連: 既存の調査',exact=True).check()
        expect(send).to_be_enabled()
        self.page.get_by_label('関連: 期限切れの確認',exact=True).check()
        expect(send).to_be_disabled()
        self.page.get_by_label('関連: 期限切れの確認',exact=True).uncheck()
        box.press('Control+Enter')
        expect(box).to_have_value('')
        stored=self.stored()[0]
        self.assertEqual(len(stored['subtasks']),2)
        small=stored['subtasks'][0]['smallTasks'][0]
        self.assertEqual(small['title'],'資料の目次を作成')
        self.assertNotIn('dueDate',small)
        self.assertNotIn('date',small)
        self.assertTrue(stored['waiting'])
        self.assertTrue(stored['subtasks'][0]['waiting'])
        self.assertEqual(len(stored['progressHistory']),1)
        message=stored['progressHistory'][0]
        self.assertEqual(message['kind'],'comment')
        self.assertTrue(message['addedSmallTask'])
        self.assertEqual(message['status'],'active')
        self.assertEqual(message['text'],small['title'])
        self.assertEqual(message['subtaskIds'],['s1'])
        self.assertEqual(message['smallTaskId'],small['id'])
        self.assertEqual(message['smallTaskTitle'],small['title'])
        expect(self.page.locator('[data-progress-entry-id]')).to_have_count(1)
        expect(self.entry(message['id'])).to_contain_text('小さいタスクの追加')
        expect(self.entry(message['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-purple-50\b'))
        row=self.page.locator('[data-progress-small-task-id="'+small['id']+'"]')
        expect(row).to_have_count(0)
        toggle=self.page.get_by_role('button',name='既存の調査の小さいタスクを展開',exact=True)
        toggle.click();expect(toggle).to_have_attribute('aria-expanded','true')
        expect(row).to_be_visible()
        expect(row).not_to_contain_text('期限')
        toggle.click();expect(row).to_have_count(0)

    def test_waiting_small_task_addition_is_lime_persists_and_replies_blue(self):
        self.seed([task(progressEnabled=True,progressStage='doing')])
        self.progress();self.select_chat()
        self.page.get_by_label('関連: 既存の調査',exact=True).check()
        self.page.get_by_label('小さいタスクの追加',exact=True).check()
        self.page.get_by_label('相手待ち',exact=True).check()
        self.send('回答待ちの資料確認')
        stored=self.stored()[0]
        small=stored['subtasks'][0]['smallTasks'][0]
        self.assertTrue(small['waiting'])
        self.assertFalse(small['completed'])
        self.assertNotIn('dueDate',small)
        self.assertFalse(stored['subtasks'][0].get('waiting',False))
        self.assertFalse(stored.get('waiting',False))
        self.assertEqual(len(stored['progressHistory']),1)
        message=stored['progressHistory'][0]
        self.assertTrue(message['addedSmallTask'])
        self.assertEqual(message['status'],'waiting')
        self.assertEqual(message['smallTaskId'],small['id'])
        self.assertEqual(message['text'],small['title'])
        self.assertEqual(message['subtaskIds'],['s1'])
        box=self.entry(message['id']).locator(':scope > div')
        expect(box).to_have_class(re.compile(r'\bbg-lime-50\b'))
        self.page.get_by_label('やるべきことで絞り込み',exact=True).select_option('s1')
        expect(self.entry(message['id'])).to_be_visible()
        self.page.reload();self.progress();self.select_chat()
        expect(box).to_have_class(re.compile(r'\bbg-lime-50\b'))
        with self.page.expect_download() as download:
            self.page.get_by_role('button',name='エクスポート',exact=True).click()
        backup=Path(download.value.path()).read_bytes()
        self.assertEqual(json.loads(backup)['tasks'][0]['progressHistory'],[message])
        self.seed([])
        self.page.locator('input[type=file]').set_input_files(dict(name='small-addition.json',mimeType='application/json',buffer=backup))
        self.progress();self.select_chat()
        expect(box).to_have_class(re.compile(r'\bbg-lime-50\b'))
        self.reply(message['id']);self.send('確認への回答を受領しました')
        stored=self.stored()[0]
        self.assertEqual(len(stored['progressHistory']),1)
        reply=stored['progressHistory'][0]
        self.assertFalse(reply['addedSmallTask'])
        self.assertEqual(reply['quote']['id'],message['id'])
        self.assertTrue(reply['quote']['addedSmallTask'])
        self.assertEqual(reply['quote']['text'],small['title'])
        self.assertEqual(reply['smallTaskId'],small['id'])
        self.assertFalse(stored['subtasks'][0]['smallTasks'][0]['waiting'])
        expect(self.entry(message['id'])).to_have_count(0)
        expect(self.entry(reply['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))

    def test_small_task_addition_comment_can_edit_status_without_duplicate_tasks(self):
        self.seed([task(progressEnabled=True,progressStage='doing')])
        self.progress();self.select_chat()
        self.page.get_by_label('関連: 既存の調査',exact=True).check()
        self.page.get_by_label('小さいタスクの追加',exact=True).check()
        self.send('調査資料の照合')
        before=self.stored()[0]
        message=before['progressHistory'][0]
        small=before['subtasks'][0]['smallTasks'][0]
        box=self.entry(message['id']).locator(':scope > div')
        self.entry(message['id']).get_by_role('button',name='コメントを編集',exact=True).click()
        expect(self.page.get_by_label('小さいタスクの追加',exact=True)).not_to_be_checked()
        self.page.get_by_label('相手待ち',exact=True).check()
        self.page.get_by_label('コメントの編集',exact=True).fill('照合のため資料の回答を依頼しました')
        self.page.get_by_role('button',name='編集を保存',exact=True).click()
        after=self.stored()[0]
        self.assertEqual(len(after['progressHistory']),1)
        self.assertEqual(len(after['subtasks'][0]['smallTasks']),1)
        edited=after['progressHistory'][0]
        self.assertEqual(edited['id'],message['id'])
        self.assertEqual(edited['createdAt'],message['createdAt'])
        self.assertEqual(edited['smallTaskId'],small['id'])
        self.assertTrue(edited['addedSmallTask'])
        self.assertEqual(edited['status'],'waiting')
        self.assertTrue(after['subtasks'][0]['smallTasks'][0]['waiting'])
        self.assertEqual(after['subtasks'][0]['smallTasks'][0]['title'],small['title'])
        expect(box).to_have_class(re.compile(r'\bbg-lime-50\b'))
        self.entry(message['id']).get_by_role('button',name='コメントを編集',exact=True).click()
        self.page.get_by_label('相手待ち',exact=True).uncheck()
        self.page.get_by_role('button',name='編集を保存',exact=True).click()
        final=self.stored()[0]
        self.assertTrue(final['progressHistory'][0]['addedSmallTask'])
        self.assertFalse(final['subtasks'][0]['smallTasks'][0]['waiting'])
        self.assertEqual(len(final['subtasks'][0]['smallTasks']),1)
        expect(box).to_have_class(re.compile(r'\bbg-purple-50\b'))

    def test_delete_small_task_addition_comment_removes_task_and_keeps_quote(self):
        original=task(progressEnabled=True,progressStage='doing',waiting=True)
        original['subtasks'][0].update(waiting=True,smallTasks=[dict(id='keep',title='残す小さい項目',completed=False)])
        original['subtasks'][1]['smallTasks']=[dict(id='other',title='別の親の項目',completed=False)]
        self.seed([original]);self.progress();self.select_chat()
        self.page.get_by_label('関連: 既存の調査',exact=True).check()
        self.page.get_by_label('小さいタスクの追加',exact=True).check()
        self.send('コメントと一緒に削除する項目')
        added=self.stored()[0]
        message=added['progressHistory'][0]
        small=added['subtasks'][0]['smallTasks'][-1]
        self.reply(message['id']);self.send('削除後も引用を残す進捗')
        before=self.stored()[0]
        reply=before['progressHistory'][-1]
        self.page.get_by_role('button',name='既存の調査の小さいタスクを展開',exact=True).click()
        row=self.page.locator('[data-progress-small-task-id="'+small['id']+'"]')
        expect(row).to_be_visible()
        self.entry(message['id']).get_by_role('button',name='コメントを削除',exact=True).click()
        expected=json.loads(json.dumps(before))
        expected['progressHistory']=[reply]
        expected['subtasks'][0]['smallTasks']=[before['subtasks'][0]['smallTasks'][0]]
        self.assertEqual(self.stored()[0],expected)
        expect(self.entry(message['id'])).to_have_count(0)
        expect(row).to_have_count(0)
        expect(self.entry(reply['id']).get_by_role('blockquote',name='引用コメント')).to_contain_text(message['text'])
        self.page.reload();self.progress();self.select_chat()
        self.assertEqual(self.stored()[0],expected)
        with self.page.expect_download() as download:
            self.page.get_by_role('button',name='エクスポート',exact=True).click()
        self.assertEqual(json.loads(Path(download.value.path()).read_text())['tasks'][0],expected)

    def test_small_task_row_delete_keeps_comments_and_other_tasks(self):
        comment=dict(id='small-note',kind='comment',createdAt='2026-01-01T01:00:00.000Z',
                     text='削除後も保持する進捗',status='waiting',subtaskIds=['s1'],subtaskTitles=['既存の調査'],
                     smallTaskId='remove',smallTaskTitle='一覧から削除する項目')
        original=task(progressEnabled=True,progressStage='doing',waiting=True,progressHistory=[comment])
        original['subtasks'][0].update(waiting=True,smallTasks=[
            dict(id='remove',title='一覧から削除する項目',waiting=True,completed=False),
            dict(id='keep',title='一覧に残す項目',completed=False)])
        original['subtasks'][1]['smallTasks']=[dict(id='other',title='別の項目',completed=True)]
        self.seed([original]);self.progress();self.select_chat()
        self.page.get_by_role('button',name='既存の調査の小さいタスクを展開',exact=True).click()
        row=self.page.locator('[data-progress-small-task-id="remove"]')
        row.dblclick()
        self.page.get_by_label('進捗コメント',exact=True).fill('送信していない下書き')
        row.get_by_role('button',name='一覧から削除する項目を削除',exact=True).click()
        expected=json.loads(json.dumps(original))
        expected['subtasks'][0]['smallTasks']=[original['subtasks'][0]['smallTasks'][1]]
        self.assertEqual(self.stored()[0],expected)
        expect(row).to_have_count(0)
        expect(self.page.locator('[data-progress-small-task-id="keep"]')).to_be_visible()
        expect(self.entry(comment['id'])).to_be_visible()
        expect(self.page.get_by_label('進捗コメント',exact=True)).to_have_value('')
        self.entry(comment['id']).get_by_role('button',name='コメントを編集',exact=True).click()
        self.page.get_by_label('コメントの編集',exact=True).fill('削除済み項目の記録を訂正')
        self.page.get_by_role('button',name='編集を保存',exact=True).click()
        after=self.stored()[0]
        self.assertEqual(after['subtasks'],expected['subtasks'])
        self.assertEqual(after['progressHistory'][0]['smallTaskId'],'remove')
        self.assertEqual(after['progressHistory'][0]['text'],'削除済み項目の記録を訂正')

    def test_small_task_delete_preserves_unrelated_reply_draft(self):
        source=dict(id='other-reply',kind='comment',createdAt='2026-01-01T01:00:00.000Z',
                    text='別件の返信元',status='active',subtaskIds=[],subtaskTitles=[])
        original=task(progressEnabled=True,progressStage='doing',progressHistory=[source])
        original['subtasks'][0]['smallTasks']=[dict(id='remove',title='以前に選択した項目',completed=False)]
        self.seed([original]);self.progress();self.select_chat()
        self.page.get_by_role('button',name='既存の調査の小さいタスクを展開',exact=True).click()
        row=self.page.locator('[data-progress-small-task-id="remove"]')
        row.dblclick();self.send('以前の項目への記録')
        self.reply(source['id'])
        editor=self.page.get_by_label('進捗コメント',exact=True)
        editor.fill('別件の返信を入力中')
        history=self.stored()[0]['progressHistory']
        row.get_by_role('button',name='以前に選択した項目を削除',exact=True).click()
        expect(row).to_have_count(0)
        expect(self.page.get_by_role('region',name='返信先',exact=True)).to_be_visible()
        expect(editor).to_have_value('別件の返信を入力中')
        self.assertEqual(self.stored()[0]['progressHistory'],history)
        editor.press('Control+Enter')
        final=self.stored()[0]
        self.assertEqual(final['subtasks'][0]['smallTasks'],[])
        self.assertEqual(final['progressHistory'][-1]['quote']['id'],source['id'])

    def test_delete_ordinary_small_comment_keeps_task_quote_and_other_editor(self):
        source=dict(id='source-note',kind='comment',createdAt='2026-01-01T01:00:00.000Z',
                    text='引用元の通常コメント',status='active',subtaskIds=['s1'],subtaskTitles=['既存の調査'],
                    smallTaskId='small1',smallTaskTitle='残す作業')
        reply=dict(id='reply-note',kind='comment',createdAt='2026-01-02T01:00:00.000Z',
                   text='引用を保持する返信',status='active',subtaskIds=['s1'],subtaskTitles=['既存の調査'],
                   smallTaskId='small1',smallTaskTitle='残す作業',quote=source)
        original=task(progressEnabled=True,progressStage='doing',waiting=True,progressHistory=[source,reply])
        original['subtasks'][0]['smallTasks']=[dict(id='small1',title='残す作業',completed=False,waiting=True)]
        self.seed([original]);self.progress();self.select_chat()
        self.entry(reply['id']).get_by_role('button',name='コメントを編集',exact=True).click()
        editor=self.page.get_by_label('コメントの編集',exact=True)
        editor.fill('編集中の返信も保持')
        self.entry(source['id']).get_by_role('button',name='コメントを削除',exact=True).click()
        expect(editor).to_have_value('編集中の返信も保持')
        expected=json.loads(json.dumps(original))
        expected['progressHistory']=[reply]
        self.assertEqual(self.stored()[0],expected)
        self.page.get_by_role('button',name='編集を保存',exact=True).click()
        after=self.stored()[0]
        self.assertEqual(after['progressHistory'][0]['quote'],source)
        self.assertEqual(after['subtasks'],original['subtasks'])
        expect(self.entry(source['id'])).to_have_count(0)
        expect(self.entry(reply['id']).get_by_role('blockquote',name='引用コメント')).to_contain_text(source['text'])

    def test_deleting_current_comment_exits_edit_or_reply_without_resurrection(self):
        source=dict(id='delete-current',kind='comment',createdAt='2026-01-01T01:00:00.000Z',
                    text='入力中に削除するコメント',status='waiting',subtaskIds=[],subtaskTitles=[])
        for mode in ['edit','reply']:
            with self.subTest(mode=mode):
                self.seed([task(progressEnabled=True,progressStage='doing',waiting=True,progressHistory=[source])])
                self.progress();self.select_chat()
                if mode=='edit':
                    self.entry(source['id']).get_by_role('button',name='コメントを編集',exact=True).click()
                    self.page.get_by_label('コメントの編集',exact=True).fill('編集中の下書き')
                else:
                    self.reply(source['id'])
                    self.page.get_by_label('進捗コメント',exact=True).fill('返信の下書き')
                self.entry(source['id']).get_by_role('button',name='コメントを削除',exact=True).click()
                self.assertEqual(self.stored()[0]['progressHistory'],[])
                self.assertTrue(self.stored()[0]['waiting'])
                expect(self.page.get_by_label('コメントの編集',exact=True)).to_have_count(0)
                expect(self.page.get_by_role('region',name='返信先',exact=True)).to_have_count(0)
                expect(self.page.get_by_label('進捗コメント',exact=True)).to_have_value('')
                self.send('削除後の新しい記録')
                history=self.stored()[0]['progressHistory']
                self.assertEqual(len(history),1)
                self.assertNotEqual(history[0]['id'],source['id'])

    def test_delete_deadline_reason_keeps_deadlines(self):
        note=dict(id='deadline-reason',kind='change',changeType='deadline',reason='顧客との日程調整',
                  text=f'タスク「進捗テスト案件」の期限を {FUTURE} → {LATER} に変更しました\n理由: 顧客との日程調整',
                  createdAt='2026-01-01T01:00:00.000Z',subtaskIds=[],subtaskTitles=[])
        original=task(progressEnabled=True,progressStage='doing',progressHistory=[note])
        original['dueDate']=LATER
        self.seed([original]);self.progress();self.select_chat()
        expect(self.entry(note['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-white\b'))
        self.entry(note['id']).get_by_role('button',name='コメントを削除',exact=True).click()
        expected=json.loads(json.dumps(original));expected['progressHistory']=[]
        self.assertEqual(self.stored()[0],expected)
        expect(self.entry(note['id'])).to_have_count(0)

    def test_nested_small_task_doubleclick_comment_edit_and_status_scope(self):
        original=task(progressEnabled=True,progressStage='doing')
        original['subtasks'][0]['smallTasks']=[dict(id='small1',title='資料の目次を作成',completed=False,waiting=False)]
        self.seed([original]);self.progress();self.select_chat()
        self.page.get_by_role('button',name='既存の調査の小さいタスクを展開',exact=True).click()
        row=self.page.locator('[data-progress-small-task-id="small1"]')
        row.dblclick()
        expect(self.page.get_by_label('関連: 既存の調査',exact=True)).to_be_checked()
        self.page.get_by_label('相手待ち',exact=True).check()
        self.send('目次案のレビューを依頼')
        stored=self.stored()[0]
        message=next(entry for entry in stored['progressHistory'] if entry['kind']=='comment')
        self.assertEqual(message['subtaskIds'],['s1'])
        self.assertEqual(message['smallTaskId'],'small1')
        self.assertEqual(message['smallTaskTitle'],'資料の目次を作成')
        self.assertTrue(stored['subtasks'][0]['smallTasks'][0]['waiting'])
        self.assertFalse(stored['subtasks'][0].get('waiting',False))
        self.assertFalse(stored.get('waiting',False))
        self.entry(message['id']).get_by_role('button',name='コメントを編集',exact=True).click()
        editor=self.page.get_by_label('コメントの編集',exact=True)
        editor.fill('目次案の内容を訂正してレビュー依頼')
        editor.press('Control+Enter')
        expect(editor).to_have_count(0)
        edited=next(entry for entry in self.stored()[0]['progressHistory'] if entry['id']==message['id'])
        self.assertEqual(edited['smallTaskId'],'small1')
        self.assertEqual(edited['subtaskIds'],['s1'])
        self.assertEqual(edited['createdAt'],message['createdAt'])
        row.get_by_role('button',name='資料の目次を作成にコメント',exact=True).press('Enter')
        self.page.get_by_label('完了',exact=True).check()
        self.send('目次作成を完了')
        stored=self.stored()[0]
        self.assertTrue(stored['subtasks'][0]['smallTasks'][0]['completed'])
        self.assertFalse(stored['subtasks'][0]['smallTasks'][0]['waiting'])
        self.assertFalse(stored['subtasks'][0]['completed'])
        self.assertFalse(stored['completed'])

    def test_nested_comments_keep_parent_only_filter_and_roundtrip(self):
        original=task(progressEnabled=True,progressStage='doing')
        original['subtasks'][0]['smallTasks']=[dict(id='small1',title='一覧に含めない小さい項目',completed=False)]
        self.seed([original]);self.progress();self.select_chat()
        expect(self.page.get_by_label('関連: 一覧に含めない小さい項目',exact=True)).to_have_count(0)
        select=self.page.get_by_label('やるべきことで絞り込み',exact=True)
        self.assertEqual(select.locator('option').all_text_contents(),['すべてのやるべきこと','既存の調査','期限切れの確認'])
        self.page.get_by_role('button',name='既存の調査の小さいタスクを展開',exact=True).click()
        self.page.locator('[data-progress-small-task-id="small1"]').dblclick()
        self.send('小さい項目についての検討記録')
        message=next(entry for entry in self.stored()[0]['progressHistory'] if entry['kind']=='comment')
        select.select_option('s1');expect(self.entry(message['id'])).to_be_visible()
        select.select_option('s2');expect(self.entry(message['id'])).to_have_count(0)
        select.select_option('')
        self.page.get_by_label('履歴を検索',exact=True).fill('一覧に含めない小さい項目')
        expect(self.entry(message['id'])).to_be_visible()
        self.page.reload();self.progress();self.select_chat()
        expect(self.entry(message['id'])).to_be_visible()
        with self.page.expect_download() as download:
            self.page.get_by_role('button',name='エクスポート',exact=True).click()
        saved=Path(download.value.path()).read_bytes()
        data=json.loads(saved)
        self.assertEqual(data['tasks'][0]['subtasks'][0]['smallTasks'][0]['id'],'small1')
        self.seed([])
        self.page.locator('input[type=file]').set_input_files(dict(name='nested-backup.json',mimeType='application/json',buffer=saved))
        self.progress();self.select_chat()
        expect(self.entry(message['id'])).to_be_visible()
        self.assertEqual(self.stored()[0]['subtasks'][0]['smallTasks'],data['tasks'][0]['subtasks'][0]['smallTasks'])

    def test_history_uses_a_single_record_column(self):
        self.seed([task(progressEnabled=True,progressStage='doing')]);self.progress();self.select_chat()
        self.send('一人用の進捗記録')
        self.send('同じ列の次の進捗記録')
        entries=self.page.locator('[data-progress-entry-id]')
        expect(entries).to_have_count(2)
        boxes=entries.evaluate_all('(elements) => elements.map(el => ({left:el.getBoundingClientRect().left,width:el.getBoundingClientRect().width,classes:el.className}))')
        self.assertAlmostEqual(boxes[0]['left'],boxes[1]['left'],delta=1)
        self.assertAlmostEqual(boxes[0]['width'],boxes[1]['width'],delta=1)
        self.assertNotIn('items-end',boxes[0]['classes'])
        self.assertEqual(self.page.locator('[data-progress-entry-id] .bg-blue-600').count(),0)

    def test_add_todo_does_not_record_automatic_comments(self):
        original=task(progressEnabled=True,progressStage='doing',waiting=True)
        original['subtasks'][0]['waiting']=True
        self.seed([original])
        self.progress();self.select_chat()
        self.page.get_by_label('やるべきことの追加',exact=True).check()
        self.send('コメントから追加する資料作成')
        stored=self.stored()[0]
        new_subtask=stored['subtasks'][-1]
        self.assertEqual(new_subtask['title'],'コメントから追加する資料作成')
        self.assertEqual(new_subtask['dueDate'],FUTURE)
        self.assertTrue(stored['waiting'])
        self.assertTrue(stored['subtasks'][0]['waiting'])
        self.assertEqual(stored.get('progressHistory',[]),[])
        expect(self.page.locator('[data-progress-entry-id]')).to_have_count(0)
        expect(self.page.get_by_role('button',name='コメントを編集',exact=True)).to_have_count(0)
        self.page.get_by_role('button',name='ボード',exact=True).click()
        expect(self.page.locator('#task-'+new_subtask['id'])).to_contain_text('コメントから追加する資料作成')

    def test_legacy_todo_bubble_is_hidden_without_deleting_saved_history(self):
        history=[
            dict(id='legacy-own',kind='comment',createdAt='2026-01-01T01:00:00.000Z',
                 text='既存の調査',subtaskIds=['s1'],subtaskTitles=['既存の調査'],addedSubtask=True,status='active'),
            dict(id='legacy-reaction',kind='change',createdAt='2026-01-01T01:00:00.001Z',
                 text='やるべきこと「既存の調査」を追加しました',subtaskIds=['s1'],subtaskTitles=['既存の調査'])]
        self.seed([task(progressEnabled=True,progressStage='doing',progressHistory=history)])
        self.progress();self.select_chat()
        expect(self.entry('legacy-own')).to_have_count(0)
        expect(self.entry('legacy-reaction')).to_have_count(0)
        expect(self.page.get_by_role('button',name='コメントを編集',exact=True)).to_have_count(0)
        self.assertEqual(self.stored()[0]['progressHistory'],history)

    def test_deadline_change_only_records_nonblank_reason(self):
        self.seed([task(progressEnabled=True,progressStage='doing')])
        self.progress();self.select_chat()
        self.card().get_by_role('button',name='進捗テスト案件の設定',exact=True).click()
        dialog=self.page.get_by_role('dialog',name='進捗の設定')
        dialog.get_by_label('タスクの期限',exact=True).fill(LATER)
        dialog.get_by_label('やるべきこと 1 の期限',exact=True).fill(LATER)
        dialog.get_by_label('変更理由',exact=True).fill('   ')
        dialog.get_by_role('button',name='確定',exact=True).click()
        self.assertEqual(self.stored()[0].get('progressHistory',[]),[])
        expect(self.page.locator('[data-progress-entry-id]')).to_have_count(0)
        self.card().get_by_role('button',name='進捗テスト案件の設定',exact=True).click()
        dialog.get_by_label('変更理由',exact=True).fill('日程を検討したが変更しない')
        dialog.get_by_role('button',name='確定',exact=True).click()
        self.assertEqual(self.stored()[0].get('progressHistory',[]),[])
        self.card().get_by_role('button',name='進捗テスト案件の設定',exact=True).click()
        dialog.get_by_label('タスクの期限',exact=True).fill(FUTURE)
        dialog.get_by_label('やるべきこと 1 の期限',exact=True).fill(FUTURE)
        dialog.get_by_label('タスク名',exact=True).fill('名前も同時に変更')
        dialog.get_by_label('変更理由',exact=True).fill('顧客との調整が完了したため')
        dialog.get_by_role('button',name='確定',exact=True).click()
        history=self.stored()[0]['progressHistory']
        self.assertEqual(len(history),2)
        for entry in history:
            self.assertEqual(entry['kind'],'change')
            self.assertEqual(entry['changeType'],'deadline')
            self.assertEqual(entry['reason'],'顧客との調整が完了したため')
            self.assertIn(LATER,entry['text']);self.assertIn(FUTURE,entry['text'])
            expect(self.entry(entry['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-white\b'))
        self.assertEqual(history[1]['subtaskIds'],['s1'])
        self.page.reload();self.progress()
        self.card().get_by_role('button',name='名前も同時に変更',exact=True).click()
        expect(self.page.locator('[data-progress-entry-id]')).to_have_count(2)

    def test_legacy_history_only_shows_comments_and_deadline_reasons(self):
        entries=[
            dict(id='normal',kind='comment',text='通常の進捗',status='active'),
            dict(id='waiting',kind='comment',text='返答待ちの進捗',status='waiting'),
            dict(id='small',kind='comment',text='小さい作業の進捗',status='active',smallTaskId='small1',smallTaskTitle='小さい項目'),
            dict(id='small-waiting',kind='comment',text='小さい作業の返答待ち',status='waiting',smallTaskId='small1',smallTaskTitle='小さい項目'),
            dict(id='deadline',kind='change',text=f'「既存の調査」の期限を {FUTURE} → {LATER} に変更しました\n理由: 顧客の回答待ち'),
            dict(id='empty-reason',kind='change',text=f'「既存の調査」の期限を {FUTURE} → {LATER} に変更しました\n理由:   '),
            dict(id='no-reason',kind='change',text=f'「既存の調査」の期限を {FUTURE} → {LATER} に変更しました'),
            dict(id='rename',kind='change',text='タスク名を変更しました\n理由: 分かりやすい名前にする'),
            dict(id='added',kind='change',text='やるべきことを追加しました'),
            dict(id='status',kind='change',text='相手待ちにしました'),
        ]
        for index,entry in enumerate(entries):
            entry.update(createdAt=f'2026-01-01T01:00:{index:02d}.000Z',subtaskIds=['s1'],subtaskTitles=['既存の調査'])
        self.seed([task(progressEnabled=True,progressStage='doing',progressHistory=entries)])
        self.progress();self.select_chat()
        expected={'normal':'bg-blue-50','waiting':'bg-green-50','small':'bg-purple-50','small-waiting':'bg-green-50','deadline':'bg-white'}
        expect(self.page.locator('[data-progress-entry-id]')).to_have_count(len(expected))
        for key,color in expected.items():
            expect(self.entry(key).locator(':scope > div')).to_have_class(re.compile(r'\b'+color+r'\b'))
        for key in ['empty-reason','no-reason','rename','added','status']:
            expect(self.entry(key)).to_have_count(0)
        self.page.get_by_label('やるべきことで絞り込み',exact=True).select_option('s1')
        expect(self.page.locator('[data-progress-entry-id]')).to_have_count(len(expected))
        self.assertEqual(self.stored()[0]['progressHistory'],entries)
        self.page.reload();self.progress();self.select_chat()
        expect(self.page.locator('[data-progress-entry-id]')).to_have_count(len(expected))
        self.assertEqual(self.stored()[0]['progressHistory'],entries)

    def test_comment_colors_follow_edited_status_and_small_task_scope(self):
        original=task(progressEnabled=True,progressStage='doing')
        original['subtasks'][0]['smallTasks']=[dict(id='small1',title='小さい項目',completed=False)]
        self.seed([original]);self.progress();self.select_chat();self.send('色を変更する進捗')
        message=self.stored()[0]['progressHistory'][0]
        box=self.entry(message['id']).locator(':scope > div')
        expect(box).to_have_class(re.compile(r'\bbg-blue-50\b'))
        self.entry(message['id']).get_by_role('button',name='コメントを編集',exact=True).click()
        self.page.get_by_label('相手待ち',exact=True).check()
        self.page.get_by_role('button',name='編集を保存',exact=True).click()
        expect(box).to_have_class(re.compile(r'\bbg-green-50\b'))
        self.entry(message['id']).get_by_role('button',name='コメントを編集',exact=True).click()
        self.page.get_by_label('相手待ち',exact=True).uncheck()
        self.page.get_by_role('button',name='編集を保存',exact=True).click()
        expect(box).to_have_class(re.compile(r'\bbg-blue-50\b'))
        self.page.get_by_role('button',name='既存の調査の小さいタスクを展開',exact=True).click()
        self.page.locator('[data-progress-small-task-id="small1"]').dblclick()
        self.send('小さい項目の通常進捗')
        small_message=self.stored()[0]['progressHistory'][-1]
        small_box=self.entry(small_message['id']).locator(':scope > div')
        expect(small_box).to_have_class(re.compile(r'\bbg-purple-50\b'))
        self.entry(small_message['id']).get_by_role('button',name='コメントを編集',exact=True).click()
        self.page.get_by_label('相手待ち',exact=True).check()
        self.page.get_by_role('button',name='編集を保存',exact=True).click()
        expect(small_box).to_have_class(re.compile(r'\bbg-green-50\b'))
        self.assertEqual(len(self.stored()[0]['progressHistory']),2)
        self.page.reload();self.progress();self.select_chat()
        expect(self.entry(small_message['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-green-50\b'))

    def test_comment_text_edit_preserves_later_status_and_history_metadata(self):
        self.seed([task(progressEnabled=True,progressStage='doing')])
        self.progress();self.select_chat()
        self.page.get_by_label('関連: 既存の調査',exact=True).check()
        self.page.get_by_label('相手待ち',exact=True).check()
        self.send('最初の担当者への依頼')
        original=next(entry for entry in self.stored()[0]['progressHistory'] if entry['kind']=='comment')
        self.page.get_by_label('関連: 既存の調査',exact=True).check()
        self.page.get_by_label('完了',exact=True).check()
        self.send('後から調査完了を記録')
        before=self.stored()[0]
        self.entry(original['id']).get_by_role('button',name='コメントを編集',exact=True).click()
        editor=self.page.get_by_label('コメントの編集',exact=True)
        expect(editor).to_have_value('最初の担当者への依頼')
        expect(self.page.get_by_label('関連: 既存の調査',exact=True)).to_be_checked()
        expect(self.page.get_by_label('相手待ち',exact=True)).to_be_checked()
        editor.fill('依頼内容を訂正しました')
        editor.press('Control+Enter')
        expect(editor).to_have_count(0)
        expect(self.entry(original['id'])).to_contain_text('依頼内容を訂正しました')
        expect(self.entry(original['id'])).to_contain_text('編集済み')
        after=self.stored()[0]
        edited=next(entry for entry in after['progressHistory'] if entry['id']==original['id'])
        self.assertEqual(edited['createdAt'],original['createdAt'])
        self.assertEqual(edited['subtaskIds'],original['subtaskIds'])
        self.assertEqual(edited['status'],original['status'])
        self.assertTrue(edited['editedAt'])
        self.assertEqual(len(after['progressHistory']),len(before['progressHistory']))
        self.assertEqual({key:value for key,value in after.items() if key!='progressHistory'},
                         {key:value for key,value in before.items() if key!='progressHistory'})
        self.page.get_by_label('履歴を検索',exact=True).fill('最初の担当者への依頼')
        expect(self.entry(original['id'])).to_have_count(0)
        self.page.get_by_label('履歴を検索',exact=True).fill('依頼内容を訂正しました')
        expect(self.entry(original['id'])).to_be_visible()
        self.page.reload();self.progress();self.select_chat()
        expect(self.entry(original['id'])).to_contain_text('依頼内容を訂正しました')
        with self.page.expect_download() as download:
            self.page.get_by_role('button',name='エクスポート',exact=True).click()
        saved=json.loads(Path(download.value.path()).read_text())
        self.assertEqual(saved['tasks'][0]['progressHistory'],self.stored()[0]['progressHistory'])

    def test_edit_comment_with_deleted_subtask_keeps_status_and_parent(self):
        history=[dict(id='deleted-subtask-comment',kind='comment',createdAt='2026-01-01T01:00:00.000Z',
                      text='削除済み項目の完了記録',subtaskIds=['removed'],subtaskTitles=['削除した項目'],status='completed')]
        self.seed([task(progressEnabled=True,progressStage='doing',waiting=True,progressHistory=history)])
        self.progress();self.select_chat()
        before=self.stored()[0]
        self.entry(history[0]['id']).get_by_role('button',name='コメントを編集',exact=True).click()
        editor=self.page.get_by_label('コメントの編集',exact=True)
        editor.fill('削除済み項目の補足を訂正');editor.press('Control+Enter')
        expect(editor).to_have_count(0)
        after=self.stored()[0]
        self.assertEqual(after['progressHistory'][0]['status'],'completed')
        self.assertEqual(after['progressHistory'][0]['subtaskIds'],['removed'])
        self.assertEqual(len(after['progressHistory']),1)
        self.assertEqual({key:value for key,value in after.items() if key!='progressHistory'},
                         {key:value for key,value in before.items() if key!='progressHistory'})

    def test_progress_settings_rename_validates_cancels_and_shares_title(self):
        self.seed([task(progressEnabled=True,progressStage='doing')])
        self.progress();self.select_chat()
        before=self.stored()[0]
        self.card().get_by_role('button',name='進捗テスト案件の設定',exact=True).click()
        dialog=self.page.get_by_role('dialog',name='進捗の設定')
        name=dialog.get_by_label('タスク名',exact=True)
        expect(name).to_have_value('進捗テスト案件')
        name.fill('')
        dialog.get_by_role('button',name='確定',exact=True).click()
        expect(dialog).to_be_visible()
        self.assertEqual(self.stored()[0],before)
        name.fill('キャンセルするタスク名')
        dialog.get_by_role('button',name='キャンセル',exact=True).click()
        self.assertEqual(self.stored()[0],before)
        self.card().get_by_role('button',name='進捗テスト案件の設定',exact=True).click()
        name.fill('  名前を変更した案件  ');name.press('Control+Enter')
        expect(dialog).to_have_count(0)
        expect(self.card().get_by_role('button',name='名前を変更した案件',exact=True)).to_be_visible()
        renamed=self.stored()[0]
        self.assertEqual(renamed['title'],'名前を変更した案件')
        self.assertEqual(renamed.get('progressHistory',[]),[])
        self.page.get_by_role('button',name='ボード',exact=True).click()
        expect(self.page.locator('#task-track')).to_contain_text('名前を変更した案件')
        self.page.reload();self.progress()
        expect(self.card().get_by_role('button',name='名前を変更した案件',exact=True)).to_be_visible()

    def test_comment_edit_cancel_and_empty_text(self):
        self.seed([task(progressEnabled=True,progressStage='doing')])
        self.progress();self.select_chat();self.send('保持する元のコメント')
        before=self.stored()[0]
        comment=next(entry for entry in before['progressHistory'] if entry['kind']=='comment')
        edit_button=self.entry(comment['id']).get_by_role('button',name='コメントを編集',exact=True)
        edit_button.click()
        editor=self.page.get_by_label('コメントの編集',exact=True)
        editor.fill('  ')
        expect(self.page.get_by_role('button',name='編集を保存',exact=True)).to_be_disabled()
        editor.press('Control+Enter')
        expect(editor).to_have_count(1)
        self.page.get_by_role('button',name='編集をキャンセル',exact=True).click()
        expect(editor).to_have_count(0)
        self.assertEqual(self.stored()[0],before)
        edit_button.click();editor.fill('取り消す変更');editor.press('Escape')
        expect(editor).to_have_count(0)
        self.assertEqual(self.stored()[0],before)

    def test_comment_edit_updates_controls_and_can_convert_to_todo(self):
        self.seed([task(progressEnabled=True,progressStage='doing')])
        self.progress();self.select_chat()
        self.page.get_by_label('関連: 既存の調査',exact=True).check()
        self.send('関連項目を変更するコメント')
        original=next(entry for entry in self.stored()[0]['progressHistory'] if entry['kind']=='comment')
        self.entry(original['id']).get_by_role('button',name='コメントを編集',exact=True).click()
        self.page.get_by_label('関連: 既存の調査',exact=True).uncheck()
        self.page.get_by_label('関連: 期限切れの確認',exact=True).check()
        self.page.get_by_label('相手待ち',exact=True).check()
        self.page.get_by_label('コメントの編集',exact=True).fill('関連項目を回答待ちに訂正')
        self.page.get_by_role('button',name='編集を保存',exact=True).click()
        expect(self.page.get_by_label('コメントの編集',exact=True)).to_have_count(0)
        stored=self.stored()[0]
        edited=next(entry for entry in stored['progressHistory'] if entry['id']==original['id'])
        self.assertEqual(edited['subtaskIds'],['s2'])
        self.assertEqual(edited['status'],'waiting')
        self.assertTrue(stored['subtasks'][1]['waiting'])
        self.assertFalse(stored['subtasks'][0].get('waiting',False))
        self.entry(original['id']).get_by_role('button',name='コメントを編集',exact=True).click()
        self.page.get_by_label('完了',exact=True).check()
        self.page.get_by_role('button',name='編集を保存',exact=True).click()
        expect(self.page.get_by_label('コメントの編集',exact=True)).to_have_count(0)
        self.assertTrue(self.stored()[0]['subtasks'][1]['completed'])
        self.assertFalse(self.stored()[0]['subtasks'][1]['waiting'])
        self.entry(original['id']).get_by_role('button',name='コメントを編集',exact=True).click()
        self.page.get_by_label('完了',exact=True).uncheck()
        self.page.get_by_label('関連: 期限切れの確認',exact=True).uncheck()
        self.page.get_by_label('やるべきことの追加',exact=True).check()
        self.page.get_by_label('追加するやるべきことの期限',exact=True).fill(LATER)
        self.page.get_by_label('コメントの編集',exact=True).fill('編集から追加した小タスク')
        self.page.get_by_role('button',name='編集を保存',exact=True).click()
        expect(self.page.get_by_label('コメントの編集',exact=True)).to_have_count(0)
        stored=self.stored()[0]
        self.assertEqual(len(stored['subtasks']),3)
        self.assertEqual(stored['subtasks'][-1]['title'],'編集から追加した小タスク')
        self.assertEqual(stored['subtasks'][-1]['dueDate'],LATER)
        self.assertEqual(stored.get('progressHistory',[]),[])

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
        self.assertEqual(data.get('progressHistory',[]),[])
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

    def test_other_page_edits_are_silent_and_tracking_toggle_keeps_comments(self):
        self.seed([task(progressEnabled=True,progressStage='doing',progressHistory=[dict(id='history1',kind='comment',createdAt='2026-01-01T01:00:00.000Z',text='保持するコメント',subtaskIds=[],subtaskTitles=[])])])
        card=self.page.locator('#task-track')
        card.get_by_role('button',name='編集',exact=True).click()
        self.page.locator('form input[type=date]').first.fill(LATER)
        self.page.get_by_role('button',name='保存する',exact=True).click()
        self.progress();self.select_chat()
        expect(self.page.get_by_text('保持するコメント',exact=True)).to_be_visible()
        self.assertEqual(len(self.stored()[0]['progressHistory']),1)
        self.assertEqual(self.stored()[0]['dueDate'],LATER)
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
