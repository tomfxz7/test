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
        # Match the deployed Babel host. Automatically exposing every new
        # imported hook hid the missing useLayoutEffect binding in production.
        source = re.sub(r"import React, \{([^}]+)\} from 'react';",
                        'const { useState, useEffect, useMemo, useRef } = React;', source)
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
        self.addCleanup(self.ctx.close)
        self.page = self.ctx.new_page()
        self.errors = []
        self.page.on('pageerror',lambda e:self.errors.append(str(e)))
        self.page.route('https://schedule.test/**', self.route)
        self.page.goto('https://schedule.test/',timeout=60000)
        expect(self.page.get_by_role('heading',name='TaskMatrix Pro')).to_be_visible(timeout=15000)

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
        expect(self.page.get_by_role('heading',name='TaskMatrix Pro')).to_be_visible(timeout=15000)

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
        expect(box).to_have_text('')

    def entry(self,entry_id):
        return self.page.locator('[data-progress-entry-id="'+entry_id+'"]')

    def reply(self,entry_id):
        self.entry(entry_id).get_by_role('button',name='コメントに返信',exact=True).click()
        expect(self.page.get_by_role('region',name='返信先',exact=True)).to_be_visible()

    def open_report(self,start='2026-10-19',end='2026-10-25'):
        self.page.get_by_role('button',name='レポート作成',exact=True).click()
        dialog=self.page.get_by_role('dialog',name='週報用レポート作成',exact=True)
        dialog.get_by_label('レポート開始日',exact=True).fill(start)
        dialog.get_by_label('レポート終了日',exact=True).fill(end)
        return dialog

    def download_report(self,dialog):
        with self.page.expect_download() as download:
            dialog.get_by_role('button',name='テキストをダウンロード',exact=True).click()
        raw=Path(download.value.path()).read_bytes()
        self.assertTrue(raw.startswith(b'\xef\xbb\xbf'))
        return download.value.suggested_filename,raw.decode('utf-8-sig')

    def test_waiting_reply_can_complete_source_and_add_next_todo(self):
        source=dict(id='waiting',kind='comment',createdAt='2026-01-01T01:00:00.000Z',
                    text='返答待ち',status='waiting',subtaskIds=['s1'],subtaskTitles=['既存の調査'])
        original=task(progressEnabled=True,progressStage='doing',progressHistory=[source])
        original['subtasks'][0]['waiting']=True
        self.seed([original]);self.progress();self.select_chat();self.reply('waiting')
        self.page.get_by_label('完了',exact=True).check()
        self.page.get_by_label('やるべきことの追加',exact=True).check()
        self.send('返答を踏まえて次の調査')
        result=self.stored()[0]
        self.assertFalse(result['subtasks'][0]['completed'])
        new=result['subtasks'][-1]
        self.assertEqual(new['title'],'返答を踏まえて次の調査')
        self.assertFalse(new['completed']);self.assertFalse(new['waiting'])
        reply=result['progressHistory'][-1]
        self.assertEqual(reply['quote']['id'],'waiting')
        self.assertEqual(reply['subtaskIds'],[new['id']])
        self.assertEqual(result['progressHistory'][0],dict(source,resolvedByReplyId=reply['id']))
        expect(self.entry('waiting').locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))
        self.page.reload();self.progress();self.select_chat()
        self.assertEqual(self.stored()[0],result)

    def test_waiting_small_reply_adds_next_small_without_completing_new_item(self):
        source=dict(id='waiting',kind='comment',createdAt='2026-01-01T01:00:00.000Z',
                    text='回答を待つ',status='waiting',subtaskIds=['s1'],subtaskTitles=['既存の調査'],smallTaskId='old',smallTaskTitle='旧作業')
        original=task(progressEnabled=True,progressStage='doing',progressHistory=[source])
        original['subtasks'][0]['smallTasks']=[dict(id='old',title='旧作業',waiting=True,completed=False)]
        self.seed([original]);self.progress();self.select_chat();self.reply('waiting')
        self.page.get_by_label('完了',exact=True).check()
        self.page.get_by_label('小さいタスクの追加',exact=True).check()
        self.send('回答に沿って実施')
        result=self.stored()[0]
        all_small=result['subtasks'][0]['smallTasks']
        self.assertTrue(next(item for item in all_small if item['id']=='old')['completed'])
        small=[item for item in all_small if item['id']!='old']
        self.assertEqual(len(small),1)
        self.assertEqual(small[0]['title'],'回答に沿って実施')
        self.assertFalse(small[0]['completed']);self.assertFalse(small[0]['waiting'])
        self.assertFalse(result['subtasks'][0]['completed'])
        reply=result['progressHistory'][-1]
        self.assertEqual(reply['smallTaskId'],small[0]['id'])
        self.assertEqual(reply['quote']['smallTaskId'],'old')

    def test_small_completion_without_text_after_multiple_replies(self):
        original=task(progressEnabled=True,progressStage='doing')
        original['subtasks'][0]['smallTasks']=[dict(id='small',title='完了対象',completed=False)]
        self.seed([original]);self.progress();self.select_chat()
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
        row=self.page.locator('[data-progress-small-task-id="small"]')
        for message in ['最初の記録','次の記録','さらに記録']:
            row.click()
            self.send(message)
        row.click()
        self.page.get_by_label('完了',exact=True).check()
        self.page.get_by_role('button',name='送信',exact=True).click()
        expect(row).to_have_class(re.compile(r'\bbg-blue-50\b'))
        result=self.stored()[0]
        self.assertTrue(result['subtasks'][0]['smallTasks'][0]['completed'])
        self.assertEqual(result['progressHistory'][-1]['status'],'completed')
        self.assertFalse(result['subtasks'][0]['completed'])
        self.assertTrue(any(entry['text']=='最初の記録' for entry in result['progressHistory']))
        self.page.reload();self.progress();self.select_chat()
        self.assertTrue(self.stored()[0]['subtasks'][0]['smallTasks'][0]['completed'])

    def test_card_click_filters_parent_and_small_talks(self):
        def comment(id,parent,small=None):
            return dict(id=id,kind='comment',createdAt='2026-01-01T01:00:00.000Z',text=id,
                        status='active',subtaskIds=[parent],subtaskTitles=[parent],smallTaskId=small,smallTaskTitle=small)
        original=task(progressEnabled=True,progressStage='doing',progressHistory=[
            comment('親の記録','s1'),comment('小作業Aの記録','s1','a'),comment('小作業Bの記録','s1','b'),comment('別親の記録','s2')])
        original['subtasks'][0]['smallTasks']=[dict(id='a',title='小作業A'),dict(id='b',title='小作業B')]
        self.seed([original]);self.progress()
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
        expect(self.entry('親の記録')).to_be_visible()
        expect(self.entry('別親の記録')).to_have_count(0)
        self.page.locator('[data-progress-small-task-id="a"]').click()
        expect(self.entry('小作業Aの記録')).to_be_visible()
        expect(self.entry('親の記録')).to_have_count(0)
        expect(self.entry('小作業Bの記録')).to_have_count(0)
        self.page.locator('[data-progress-small-task-id="b"]').click()
        expect(self.entry('小作業Bの記録')).to_be_visible()
        expect(self.entry('小作業Aの記録')).to_have_count(0)
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
        expect(self.entry('親の記録')).to_be_visible()
        expect(self.entry('小作業Aの記録')).to_be_visible()
        self.select_chat()
        expect(self.entry('別親の記録')).to_be_visible()

    def test_edit_reply_completion_retains_small_origin_even_if_already_marked_completed(self):
        for prior_status in ['active', 'completed']:
            with self.subTest(prior_status=prior_status):
                addition=dict(id='addition',kind='comment',createdAt='2026-10-29T01:00:00Z',text='照合作業',
                              status='active',subtaskIds=['s1'],subtaskTitles=['既存の調査'],
                              smallTaskId='small',smallTaskTitle='照合作業',addedSmallTask=True)
                quoted=dict(addition,id='quoted',text='確認した内容',addedSmallTask=False)
                reply=dict(addition,id='reply',text='確認結果の補足',addedSmallTask=False,
                           status=prior_status,quote=quoted)
                original=task(progressEnabled=True,progressStage='doing',progressHistory=[addition,reply])
                original['subtasks'][0]['smallTasks']=[dict(id='small',title='照合作業',completed=False,waiting=False),
                                                       dict(id='keep',title='別の作業',completed=False)]
                self.seed([original]);self.progress()
                self.page.get_by_role('button',name='照合作業のトークを表示',exact=True).click()
                self.entry('reply').get_by_role('button',name='コメントを編集',exact=True).click()
                self.page.get_by_label('完了',exact=True).check()
                self.page.get_by_role('button',name='編集を保存',exact=True).click()
                expect(self.page.get_by_label('コメントの編集',exact=True)).to_have_count(0)
                result=self.stored()[0]
                self.assertEqual([small['id'] for small in result['subtasks'][0]['smallTasks']],['small','keep'])
                self.assertTrue(result['subtasks'][0]['smallTasks'][0]['completed'])
                self.assertFalse(result['subtasks'][0]['completed'])
                self.assertEqual(result['progressHistory'][0],addition)
                self.assertEqual(result['progressHistory'][1]['quote'],quoted)
                self.assertEqual(result['progressHistory'][1]['status'],'completed')
                self.page.reload();self.progress();self.select_chat()
                self.assertEqual(self.stored()[0]['subtasks'][0]['smallTasks'],result['subtasks'][0]['smallTasks'])

    def test_completed_small_thread_is_blue_and_addition_is_retained(self):
        def note(id,status='active',**extra):
            return dict(id=id,kind='comment',createdAt='2026-01-01T01:00:00Z',text=id,status=status,
                        subtaskIds=['s1'],subtaskTitles=['既存の調査'],smallTaskId='small',smallTaskTitle='確認作業',**extra)
        addition=note('追加',addedSmallTask=True)
        active=note('進捗')
        waiting=note('回答待ち','waiting')
        plain=note('メモ',plainComment=True)
        reply=note('補足',quote=waiting)
        original=task(progressEnabled=True,progressStage='doing',progressHistory=[addition,active,waiting,plain,reply])
        original['subtasks'][0]['smallTasks']=[dict(id='small',title='確認作業'),dict(id='keep',title='次の作業')]
        self.seed([original]);self.progress()
        small=self.page.get_by_role('button',name='確認作業のトークを表示',exact=True)
        expect(small).to_be_visible();small.click()
        expect(self.page.get_by_role('region',name='返信先',exact=True)).to_have_count(0)
        self.page.get_by_label('完了',exact=True).check();self.send('確認完了')
        result=self.stored()[0]
        self.assertEqual(result['completedSmallTaskIds'],['small'])
        self.assertEqual([s['id'] for s in result['subtasks'][0]['smallTasks']],['small','keep'])
        self.assertTrue(result['subtasks'][0]['smallTasks'][0]['completed'])
        expect(self.page.locator('[data-progress-small-task-id="small"]')).to_have_class(re.compile(r'\bbg-blue-50\b'))
        self.page.get_by_role('button',name='確認作業のトークを表示',exact=True).click()
        expect(self.page.get_by_role('region',name='返信先',exact=True)).to_have_count(0)
        for original_entry in [addition,active,waiting,plain,reply]:
            self.assertIn(dict(original_entry,resolvedByReplyId='補足') if original_entry['id']=='回答待ち' else original_entry,result['progressHistory'])
            color = 'gray' if original_entry.get('plainComment') else 'blue'
            expect(self.entry(original_entry['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-'+color+r'-50\b'))
        expect(self.entry('補足').get_by_role('blockquote')).to_have_class(re.compile(r'\bborder-blue-500\b'))
        expect(self.page.get_by_role('button',name='次の作業のトークを表示',exact=True)).to_be_visible()
        self.assertFalse(result['subtasks'][0]['completed'])
        # Completion survives deletion of the final completion message too.
        self.entry(result['progressHistory'][-1]['id']).get_by_role('button',name='コメントを削除',exact=True).click()
        self.assertEqual(self.stored()[0]['completedSmallTaskIds'],['small'])
        self.page.reload();self.progress()
        self.page.get_by_role('button',name='確認作業のトークを表示',exact=True).click()
        expect(self.entry('回答待ち').locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))
        with self.page.expect_download() as download:
            self.page.get_by_role('button',name='エクスポート',exact=True).click()
        saved=Path(download.value.path()).read_bytes()
        self.seed([])
        self.page.get_by_label('バックアップをインポート',exact=True).set_input_files(dict(name='completed-thread.json',mimeType='application/json',buffer=saved))
        self.progress()
        self.page.get_by_role('button',name='確認作業のトークを表示',exact=True).click()
        self.assertEqual(self.stored()[0]['completedSmallTaskIds'],['small'])
        expect(self.entry('メモ').locator(':scope > div')).to_have_class(re.compile(r'\bbg-gray-50\b'))

    def test_parent_completion_button_waits_for_all_children_and_closes_parent(self):
        original=task(progressEnabled=True,progressStage='doing')
        original['subtasks'][0]['smallTasks']=[dict(id='a',title='作業A'),dict(id='b',title='作業B',waiting=True)]
        self.seed([original]);self.progress()
        complete=self.page.get_by_role('button',name='既存の調査を完了',exact=True)
        expect(complete).to_have_count(0)
        self.page.get_by_role('button',name='作業Aのトークを表示',exact=True).click()
        self.page.get_by_label('完了',exact=True).check();self.send('A終了')
        expect(complete).to_have_count(0)
        self.page.get_by_role('button',name='作業Bのトークを表示',exact=True).click()
        self.page.get_by_label('完了',exact=True).check();self.send('B終了')
        expect(complete).to_be_visible()
        complete.click()
        expect(complete).to_have_count(0)
        result=self.stored()[0]
        self.assertTrue(result['subtasks'][0]['completed']);self.assertFalse(result['completed'])
        card=self.page.locator('[data-progress-subtask-id="s1"]')
        expect(card).to_have_class(re.compile(r'\bbg-blue-50\b'))
        self.select_chat()
        expect(self.page.get_by_role('log').locator('[data-progress-entry-id] > div.bg-blue-50')).to_have_count(3)
        self.page.reload();self.progress()
        expect(card).to_have_class(re.compile(r'\bbg-blue-50\b'))

    def test_all_cards_filter_without_expanding_or_quoting(self):
        def note(id,parent=None,small=None,**extra):
            return dict(id=id,kind='comment',createdAt='2026-01-01T01:00:00Z',text=id,status='active',
                        subtaskIds=[parent] if parent else [],subtaskTitles=[parent] if parent else [],smallTaskId=small,**extra)
        original=task(progressEnabled=True,progressStage='todo',progressHistory=[note('全体'),note('親','s1'),note('A','s1','a'),note('B','s1','b'),note('別親','s2')])
        original['subtasks'][0]['smallTasks']=[dict(id='a',title='作業A'),dict(id='b',title='作業B')]
        self.seed([original]);self.progress()
        for name in ['作業A','作業B']:
            expect(self.page.get_by_role('button',name=name+'のトークを表示',exact=True)).to_be_visible()
        parent=self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True)
        for _ in range(2):
            parent.click()
            expect(self.page.get_by_role('log').locator('[data-progress-entry-id]')).to_have_count(3)
            expect(self.page.get_by_role('button',name='作業Aのトークを表示',exact=True)).to_be_visible()
        a=self.page.get_by_role('button',name='作業Aのトークを表示',exact=True)
        for action in [lambda: a.click(), lambda: a.dblclick(), lambda: a.press('Enter')]:
            action()
            expect(self.entry('A')).to_be_visible();expect(self.entry('B')).to_have_count(0)
            expect(self.page.get_by_role('region',name='返信先',exact=True)).to_have_count(0)
        self.send('Aの記録追加')
        self.send('Aの記録を続ける')
        self.assertEqual([e['smallTaskId'] for e in self.stored()[0]['progressHistory'][-2:]],['a','a'])
        self.page.get_by_role('button',name='進捗テスト案件',exact=True).click()
        expect(self.page.get_by_role('log').locator('[data-progress-entry-id]')).to_have_count(7)
        self.page.get_by_label('小さいタスクで絞り込み',exact=True).select_option('b')
        expect(self.entry('A')).to_have_count(0)
        self.page.get_by_role('button',name='進捗テスト案件',exact=True).click()
        expect(self.entry('全体')).to_be_visible()

    def test_unified_status_colors_and_closed_task_threads(self):
        notes=[dict(id=name,kind='comment',createdAt='2026-01-01T01:00:00Z',text=name,status=status,
                    subtaskIds=[parent] if parent else [],subtaskTitles=[parent] if parent else [])
               for name,status,parent in [('全体','active',None),('返答待ち','waiting','s1'),('期限超過','active','s2')]]
        original=task(progressEnabled=True,progressStage='doing',progressHistory=notes)
        self.seed([original]);self.progress();self.select_chat()
        expect(self.card()).to_have_class(re.compile(r'\bbg-purple-50\b'))
        for name,color in [('全体','purple'),('返答待ち','green'),('期限超過','red')]:
            expect(self.entry(name).locator(':scope > div')).to_have_class(re.compile(r'\bbg-'+color+r'-50\b'))
        original.update(completed=True)
        self.seed([original]);self.progress();self.select_chat()
        expect(self.card()).to_have_class(re.compile(r'\bbg-blue-50\b'))
        for name in ['全体','返答待ち','期限超過']:
            expect(self.entry(name).locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))

    def test_waiting_colors_parent_and_has_no_separate_card(self):
        original=task(progressEnabled=True,progressStage='doing',progressHistory=[
            dict(id='w1',kind='comment',text='資料待ち',status='waiting',createdAt='2026-01-01T01:00:00Z',subtaskIds=['s1'],subtaskTitles=['既存の調査']),
            dict(id='w2',kind='comment',text='別の回答待ち',status='waiting',createdAt='2026-01-01T01:00:00Z',subtaskIds=[],subtaskTitles=[])])
        original['subtasks'][0]['waiting']=True
        self.seed([original]);self.progress()
        expect(self.page.locator('[data-progress-waiting-task-id]')).to_have_count(0)
        expect(self.page.locator('[data-progress-subtask-id="s1"]')).to_have_class(re.compile(r'\bbg-green-50\b'))
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
        expect(self.entry('w1')).to_be_visible();expect(self.entry('w2')).to_have_count(0)
        expect(self.page.get_by_role('region',name='返信先',exact=True)).to_have_count(0)
        self.reply('w1');self.send('受領しました')
        expect(self.page.locator('[data-progress-subtask-id="s1"]')).to_have_class(re.compile(r'\bbg-purple-50\b'))
        expect(self.page.locator('[data-progress-waiting-task-id]')).to_have_count(0)

    def test_waiting_scope_records_without_extra_card_or_implicit_quote(self):
        for parent in [None, 's1']:
            with self.subTest(parent=parent):
                source=dict(id='waiting-topic',kind='comment',createdAt='2026-01-01T01:00:00Z',text='受領待ち',
                            status='waiting',subtaskIds=[parent] if parent else [],subtaskTitles=['既存の調査'] if parent else [])
                original=task(progressEnabled=True,progressStage='doing',waiting=not parent,progressHistory=[source])
                if parent: original['subtasks'][0]['waiting']=True
                self.seed([original]);self.progress()
                if parent: self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
                else: self.select_chat()
                expect(self.page.locator('[data-progress-waiting-task-id]')).to_have_count(0)
                self.send('受領の進捗記録')
                expect(self.page.get_by_role('log')).to_contain_text('受領の進捗記録')
                result=self.stored()[0]
                self.assertNotIn('quote',result['progressHistory'][-1])
                self.assertFalse(result['completed']);self.assertFalse(result['subtasks'][0]['completed'])
                self.assertFalse(result['subtasks'][0].get('waiting',False));self.assertFalse(result.get('waiting',False))

    def dependency_dialog(self, title):
        self.page.get_by_role('button',name=title+'のタスク待ちを設定',exact=True).click()
        return self.page.get_by_role('dialog',name='タスク待ちの設定',exact=True)

    def test_small_dependency_is_yellow_then_unblocks_when_sibling_completes(self):
        original=task(progressEnabled=True,progressStage='doing')
        original['subtasks'][0]['smallTasks']=[dict(id='a',title='先行作業'),dict(id='b',title='後続作業')]
        original['subtasks'][1]['smallTasks']=[dict(id='outside',title='別のやるべきことの小さいタスク')]
        self.seed([original]);self.progress()
        dialog=self.dependency_dialog('後続作業')
        expect(dialog.get_by_label('完了を待つ: 小さいタスク 先行作業',exact=True)).to_be_visible()
        expect(dialog.get_by_label('完了を待つ: 小さいタスク 後続作業',exact=True)).to_have_count(0)
        expect(dialog.get_by_label('完了を待つ: やるべきこと 既存の調査',exact=True)).to_have_count(0)
        expect(dialog.get_by_text('別のやるべきことの小さいタスク',exact=True)).to_have_count(0)
        dialog.get_by_label('完了を待つ: 小さいタスク 先行作業',exact=True).check()
        dialog.get_by_role('button',name='タスク待ちを保存',exact=True).click()
        card=self.page.locator('[data-progress-small-task-id="b"]')
        expect(card).to_have_class(re.compile(r'\bbg-yellow-50\b'))
        self.page.get_by_role('button',name='後続作業のトークを表示',exact=True).click()
        expect(self.page.get_by_label('完了',exact=True)).to_be_disabled()
        expect(self.page.get_by_role('status')).to_contain_text('先行作業')
        self.send('先行作業を待って準備中')
        waiting_record=self.stored()[0]['progressHistory'][-1]
        self.reply(waiting_record['id'])
        self.page.get_by_label('小さいタスクの追加',exact=True).check()
        expect(self.page.get_by_label('完了',exact=True)).to_be_disabled()
        self.page.get_by_role('button',name='返信をキャンセル',exact=True).click()
        self.page.get_by_label('小さいタスクの追加',exact=True).uncheck()
        self.page.get_by_role('button',name='先行作業のトークを表示',exact=True).click()
        self.page.get_by_label('完了',exact=True).check();self.send('先行作業を完了')
        expect(card).to_have_class(re.compile(r'\bbg-purple-50\b'))
        self.page.get_by_role('button',name='後続作業のトークを表示',exact=True).click()
        expect(self.page.get_by_label('完了',exact=True)).to_be_enabled()
        self.page.reload();self.progress()
        expect(card).to_have_class(re.compile(r'\bbg-purple-50\b'))
        self.assertEqual(self.stored()[0]['subtasks'][0]['smallTasks'][1]['dependencies'][0]['id'],'a')
        with self.page.expect_download() as download:
            self.page.get_by_role('button',name='エクスポート',exact=True).click()
        saved=Path(download.value.path()).read_bytes()
        self.seed([]);self.page.get_by_label('バックアップをインポート',exact=True).set_input_files(dict(name='dependencies.json',mimeType='application/json',buffer=saved))
        self.progress();expect(card).to_have_class(re.compile(r'\bbg-purple-50\b'))

    def test_parent_dependency_and_small_wait_for_other_parent(self):
        original=task(progressEnabled=True,progressStage='doing')
        original['subtasks'][1]['dueDate']=FUTURE
        original['subtasks'][0]['smallTasks']=[dict(id='a',title='資料を使う作業')]
        self.seed([original]);self.progress()
        dialog=self.dependency_dialog('資料を使う作業')
        dialog.get_by_label('完了を待つ: やるべきこと 期限切れの確認',exact=True).check()
        dialog.get_by_role('button',name='タスク待ちを保存',exact=True).click()
        child=self.page.locator('[data-progress-small-task-id="a"]')
        expect(child).to_have_class(re.compile(r'\bbg-yellow-50\b'))
        dialog=self.dependency_dialog('既存の調査')
        expect(dialog.get_by_role('checkbox')).to_have_count(1)
        dialog.get_by_label('完了を待つ: やるべきこと 期限切れの確認',exact=True).check()
        dialog.get_by_role('button',name='タスク待ちを保存',exact=True).click()
        parent=self.page.locator('[data-progress-subtask-id="s1"]')
        expect(parent).to_have_class(re.compile(r'\bbg-yellow-50\b'))
        expect(self.page.get_by_role('button',name='既存の調査を完了',exact=True)).to_have_count(0)
        self.page.get_by_role('button',name='期限切れの確認を完了',exact=True).click()
        expect(parent).to_have_class(re.compile(r'\bbg-purple-50\b'))
        expect(child).to_have_class(re.compile(r'\bbg-purple-50\b'))

    def test_dependency_cycles_and_cancel_do_not_change_saved_links(self):
        original=task(progressEnabled=True,progressStage='doing')
        original['subtasks'][0]['smallTasks']=[dict(id='a',title='作業A'),dict(id='b',title='作業B')]
        self.seed([original]);self.progress()
        dialog=self.dependency_dialog('作業A');dialog.get_by_label('完了を待つ: 小さいタスク 作業B',exact=True).check()
        dialog.get_by_role('button',name='タスク待ちを保存',exact=True).click()
        before=self.stored()[0]
        dialog=self.dependency_dialog('作業B');dialog.get_by_label('完了を待つ: 小さいタスク 作業A',exact=True).check()
        dialog.get_by_role('button',name='タスク待ちを保存',exact=True).click()
        expect(dialog.get_by_role('alert')).to_contain_text('循環')
        self.assertEqual(self.stored()[0],before)
        dialog.get_by_role('button',name='キャンセル',exact=True).click()
        dialog=self.dependency_dialog('期限切れの確認');dialog.get_by_label('完了を待つ: やるべきこと 既存の調査',exact=True).check()
        dialog.get_by_role('button',name='タスク待ちを保存',exact=True).click()
        dialog=self.dependency_dialog('作業B');dialog.get_by_label('完了を待つ: やるべきこと 期限切れの確認',exact=True).check()
        dialog.get_by_role('button',name='タスク待ちを保存',exact=True).click()
        expect(dialog.get_by_role('alert')).to_contain_text('循環')
        dialog.get_by_role('button',name='キャンセル',exact=True).click()

    def test_multiple_dependencies_and_deleted_target_stay_blocked_until_review(self):
        original=task(progressEnabled=True,progressStage='doing')
        original['subtasks'][0]['smallTasks']=[dict(id='a',title='作業A'),dict(id='b',title='作業B'),dict(id='c',title='作業C')]
        self.seed([original]);self.progress()
        dialog=self.dependency_dialog('作業C')
        for name in ['作業A','作業B']: dialog.get_by_label('完了を待つ: 小さいタスク '+name,exact=True).check()
        dialog.get_by_role('button',name='タスク待ちを保存',exact=True).click()
        target=self.page.locator('[data-progress-small-task-id="c"]')
        self.page.get_by_role('button',name='作業Aのトークを表示',exact=True).click()
        self.page.get_by_label('完了',exact=True).check();self.send('A終了')
        expect(target).to_have_class(re.compile(r'\bbg-yellow-50\b'))
        self.page.get_by_role('button',name='作業Bを削除',exact=True).click()
        expect(target).to_have_class(re.compile(r'\bbg-yellow-50\b'))
        dialog=self.dependency_dialog('作業C')
        expect(dialog).to_contain_text('削除された関連先')
        dialog.get_by_label('完了を待つ: 小さいタスク 作業B',exact=True).uncheck()
        dialog.get_by_role('button',name='タスク待ちを保存',exact=True).click()
        expect(target).to_have_class(re.compile(r'\bbg-purple-50\b'))

    @staticmethod
    def progress_png():
        import struct, zlib
        def chunk(kind, payload):
            return struct.pack('>I',len(payload))+kind+payload+struct.pack('>I',zlib.crc32(kind+payload))
        return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',1,1,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(b'\x00\xff\x00\x00\xff'))+chunk(b'IEND',b'')

    def test_talk_images_links_edit_quote_and_backup_roundtrip(self):
        import base64
        source=dict(id='legacy-media',kind='comment',text='画像と仕様を確認',status='active',createdAt=TODAY.isoformat()+'T01:00:00Z',subtaskIds=[],subtaskTitles=[],
                    images=[dict(id='image',name='確認.png',src='data:image/png;base64,'+base64.b64encode(self.progress_png()).decode())],
                    links=[dict(id='link',url='https://example.com/spec',label='仕様書')])
        self.seed([task(progressEnabled=True,progressStage='doing',progressHistory=[source])]);self.progress();self.select_chat()
        image=self.entry(source['id']).get_by_role('img',name='確認.png',exact=True)
        expect(image).to_be_visible();self.assertEqual(image.evaluate('el=>el.naturalWidth'),1)
        link=self.entry(source['id']).get_by_role('link',name='仕様書',exact=True)
        expect(link).to_have_attribute('href','https://example.com/spec');expect(link).to_have_attribute('rel','noopener noreferrer')
        self.reply(source['id']);self.send('添付を引用して確認')
        reply=self.stored()[0]['progressHistory'][-1]
        self.assertEqual(reply['quote']['images'],source['images']);self.assertEqual(reply['quote']['links'],source['links'])
        self.entry(source['id']).get_by_role('button',name='コメントを編集',exact=True).click()
        editor=self.page.get_by_label('コメントの編集',exact=True)
        composer=self.page.locator('form').filter(has=editor)
        composer.get_by_role('button',name='画像を拡大: 確認.png',exact=True).click()
        viewer=self.page.get_by_role('dialog',name='トークの画像',exact=True)
        expect(viewer.get_by_role('img')).to_be_visible()
        viewer.get_by_role('button',name='画像を閉じる',exact=True).press('Escape')
        expect(viewer).to_have_count(0);expect(editor).to_be_visible()
        composer.get_by_role('button',name='添付画像を削除: 確認.png',exact=True).click()
        composer.get_by_role('button',name='添付リンクを削除: 仕様書',exact=True).click()
        self.page.get_by_role('button',name='編集を保存',exact=True).click()
        updated=self.stored()[0]['progressHistory']
        self.assertEqual(updated[0]['images'],[]);self.assertEqual(updated[0]['links'],[])
        self.assertEqual(updated[-1]['quote']['images'],source['images'])
        self.page.reload();self.progress();self.select_chat()
        expect(self.entry(reply['id']).get_by_role('img',name='確認.png',exact=True)).to_be_visible()
        with self.page.expect_download() as download:
            self.page.get_by_role('button',name='エクスポート',exact=True).click()
        saved=Path(download.value.path()).read_bytes()
        self.seed([]);self.page.get_by_label('バックアップをインポート',exact=True).set_input_files(dict(name='talk-media.json',mimeType='application/json',buffer=saved))
        self.progress();self.select_chat()
        self.assertEqual(self.stored()[0]['progressHistory'][-1]['quote']['images'],source['images'])
        expect(self.entry(reply['id']).get_by_role('link',name='仕様書',exact=True)).to_have_attribute('href','https://example.com/spec')

    def test_attachment_only_comment_and_invalid_link_or_image(self):
        self.seed([task(progressEnabled=True,progressStage='doing')]);self.progress();self.select_chat()
        editor=self.page.get_by_label('進捗コメント',exact=True)
        editor.evaluate('''el=>{const data=new DataTransfer();data.items.add(new File(['<svg/>'],'不正.svg',{type:'image/svg+xml'}));el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}))}''')
        expect(self.page.get_by_role('alert')).to_contain_text('PNG')
        expect(self.page.get_by_role('button',name='送信',exact=True)).to_be_disabled()
        editor.evaluate('''(el,bytes)=>{const data=new DataTransfer();data.items.add(new File([new Uint8Array(bytes)],'画像だけ.png',{type:'image/png'}));el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}))}''',list(self.progress_png()))
        expect(self.page.get_by_role('img',name='画像だけ.png',exact=True)).to_be_visible()
        self.page.get_by_label('ただのコメント',exact=True).check()
        self.page.get_by_role('button',name='送信',exact=True).click()
        expect(self.page.get_by_role('button',name='送信',exact=True)).to_be_disabled()
        comment=self.stored()[0]['progressHistory'][-1]
        self.assertEqual(comment['text'],'');self.assertEqual(len(comment['images']),1)
        expect(self.entry(comment['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-gray-50\b'))
        self.assertFalse(self.stored()[0]['completed'])

    def test_image_paste_cancel_and_report_does_not_include_binary(self):
        self.seed([task(progressEnabled=True,progressStage='doing')]);self.progress();self.select_chat()
        editor=self.page.get_by_label('進捗コメント',exact=True)
        editor.evaluate('''(el,bytes)=>{const data=new DataTransfer();data.items.add(new File([new Uint8Array(bytes)],'貼付.png',{type:'image/png'}));el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}))}''',list(self.progress_png()))
        expect(self.page.get_by_role('img',name='貼付.png',exact=True)).to_be_visible()
        self.send('貼り付けた画像 https://example.com/result')
        before=self.stored()[0]
        comment=before['progressHistory'][0]
        self.entry(comment['id']).get_by_role('button',name='コメントを編集',exact=True).click()
        self.page.locator('form').filter(has=self.page.get_by_label('コメントの編集',exact=True)).get_by_role('button',name='添付画像を削除: 貼付.png',exact=True).click()
        self.page.get_by_role('button',name='編集をキャンセル',exact=True).click()
        self.assertEqual(self.stored()[0],before)
        dialog=self.open_report(start=TODAY.isoformat(),end=TODAY.isoformat())
        _,body=self.download_report(dialog)
        self.assertIn('貼付.png',body);self.assertIn('https://example.com/result',body)
        self.assertNotIn('data:image',body)

    def test_waiting_status_popup_scopes_counts_and_preserves_data(self):
        def waiting(id,text,parent=None,small=None,**extra):
            return dict(id=id,kind='comment',text=text,status='waiting',createdAt='2026-11-01T01:00:00Z',
                        subtaskIds=[parent] if parent else [],subtaskTitles=[parent] if parent else [],smallTaskId=small,**extra)
        notes=[waiting('root','全体の返答待ち'),waiting('parent','調査の返答待ち','s1'),
               waiting('old','以前の資料待ち','s1','a'),waiting('latest','最新の資料待ち','s1','a',editedAt='2026-11-04T01:00:00Z'),
               waiting('resolved','解除済みの返答待ち','s2'),waiting('deleted','削除済み項目の返答待ち','s1','missing'),
               waiting('memo','表示しない通常メモ','s1','a',plainComment=True,editedAt='2026-11-05T01:00:00Z')]
        original=task(progressEnabled=True,progressStage='doing',waiting=True,progressHistory=notes)
        original['subtasks'][0].update(waiting=True,smallTasks=[dict(id='a',title='資料確認',waiting=True),dict(id='done',title='完了した作業',waiting=True,completed=True)])
        self.seed([original]);self.progress()
        before=self.stored()
        root=self.page.get_by_role('button',name='進捗テスト案件の相手待ち一覧',exact=True)
        expect(root).to_contain_text('3')
        root.click()
        dialog=self.page.get_by_role('dialog',name='相手待ちステータス一覧',exact=True)
        expect(dialog.locator('[data-waiting-status-key]')).to_have_count(3)
        for text in ['全体の返答待ち','調査の返答待ち','最新の資料待ち']: expect(dialog).to_contain_text(text)
        for text in ['以前の資料待ち','解除済みの返答待ち','削除済み項目の返答待ち','表示しない通常メモ']: expect(dialog).not_to_contain_text(text)
        close=dialog.get_by_role('button',name='相手待ち一覧を閉じる',exact=True)
        expect(close).to_be_focused()
        close.press('Shift+Tab');expect(dialog.get_by_role('button',name='閉じる',exact=True)).to_be_focused()
        dialog.get_by_role('button',name='閉じる',exact=True).press('Tab');expect(close).to_be_focused()
        close.press('Escape');expect(dialog).to_have_count(0);expect(root).to_be_focused()
        expect(self.page.get_by_role('log',name='進捗履歴')).to_have_count(0)
        self.page.get_by_role('button',name='既存の調査の相手待ち一覧',exact=True).click()
        expect(dialog.locator('[data-waiting-status-key]')).to_have_count(2)
        expect(dialog).not_to_contain_text('全体の返答待ち')
        dialog.get_by_role('button',name='閉じる',exact=True).click()
        self.page.get_by_role('button',name='資料確認の相手待ち一覧',exact=True).click()
        expect(dialog.locator('[data-waiting-status-key]')).to_have_count(1)
        expect(dialog).to_contain_text('最新の資料待ち');expect(dialog).not_to_contain_text('調査の返答待ち')
        dialog.get_by_role('button',name='閉じる',exact=True).click()
        self.assertEqual(self.stored(),before)
        expect(self.page.locator('[data-progress-waiting-task-id]')).to_have_count(0)

    def test_waiting_status_popup_updates_after_resolution_and_completed_scopes_are_empty(self):
        note=dict(id='wait',kind='comment',text='回答を依頼中',status='waiting',createdAt='2026-11-01T01:00:00Z',subtaskIds=['s1'],subtaskTitles=['既存の調査'],smallTaskId='a')
        original=task(progressEnabled=True,progressStage='doing',progressHistory=[note])
        original['subtasks'][0]['smallTasks']=[dict(id='a',title='照合',waiting=True)]
        self.seed([original]);self.progress()
        button=self.page.get_by_role('button',name='照合の相手待ち一覧',exact=True)
        expect(button).to_contain_text('1');button.click()
        dialog=self.page.get_by_role('dialog',name='相手待ちステータス一覧',exact=True)
        expect(dialog).to_contain_text('回答を依頼中')
        dialog.get_by_role('button',name='閉じる',exact=True).click()
        self.page.get_by_role('button',name='照合のトークを表示',exact=True).click()
        self.reply('wait');self.send('回答を受領')
        expect(button).to_contain_text('0');button.click()
        expect(dialog).to_contain_text('現在、相手待ちの項目はありません。')
        dialog.get_by_role('button',name='閉じる',exact=True).click()
        for closed_scope in ['parent','task']:
            with self.subTest(closed_scope=closed_scope):
                closed=json.loads(json.dumps(original))
                if closed_scope=='parent': closed['subtasks'][0]['completed']=True
                else: closed.update(completed=True,waiting=True)
                self.seed([closed]);self.progress()
                self.page.get_by_role('button',name='進捗テスト案件の相手待ち一覧',exact=True).click()
                expect(dialog.locator('[data-waiting-status-key]')).to_have_count(0)
                dialog.get_by_role('button',name='閉じる',exact=True).click()

    def test_waiting_status_popup_without_note_and_with_media(self):
        image={'id':'image','name':'待ちの資料.png','src':'data:image/png;base64,'+__import__('base64').b64encode(self.progress_png()).decode()}
        note=dict(id='wait',kind='comment',text='資料の回答待ち',status='waiting',createdAt='2026-11-01T01:00:00Z',subtaskIds=['s1'],subtaskTitles=['既存の調査'],smallTaskId='a',
                  images=[image],links=[dict(id='link',url='https://example.com/request',label='依頼先資料')])
        original=task(progressEnabled=True,progressStage='doing',waiting=True,progressHistory=[note])
        original['subtasks'][0]['smallTasks']=[dict(id='a',title='照合',waiting=True)]
        self.seed([original]);self.progress()
        before=self.stored()
        self.page.get_by_role('button',name='進捗テスト案件の相手待ち一覧',exact=True).click()
        dialog=self.page.get_by_role('dialog',name='相手待ちステータス一覧',exact=True)
        expect(dialog).to_contain_text('相手待ちの内容はまだ記録されていません。')
        expect(dialog.get_by_role('link',name='依頼先資料',exact=True)).to_have_attribute('href','https://example.com/request')
        expect(dialog.get_by_role('img',name='待ちの資料.png',exact=True)).to_be_visible()
        dialog.get_by_role('button',name='画像を拡大: 待ちの資料.png',exact=True).click()
        viewer=self.page.get_by_role('dialog',name='トークの画像',exact=True)
        viewer.get_by_role('button',name='画像を閉じる',exact=True).press('Escape')
        expect(viewer).to_have_count(0);expect(dialog).to_be_visible()
        dialog.get_by_role('button',name='閉じる',exact=True).click()
        self.assertEqual(self.stored(),before)

    def test_task_card_click_handles_null_media_in_saved_talks_and_quotes(self):
        record=dict(id='null-media',kind='comment',text='以前に保存したトーク',status='active',createdAt=TODAY.isoformat()+'T01:00:00Z',subtaskIds=[],subtaskTitles=[],images=None,links=None)
        quoted=dict(record,id='quote-null',text='添付欄がnullの引用',quote=record)
        original=task(progressEnabled=True,progressStage='doing',progressHistory=[record,quoted])
        self.seed([original]);self.progress()
        before=self.stored()
        self.card().click(position={'x':5,'y':5})
        expect(self.page.get_by_role('heading',name='TaskMatrix Pro',exact=True)).to_be_visible()
        expect(self.page.get_by_role('log',name='進捗履歴')).to_be_visible()
        expect(self.entry('null-media')).to_be_visible()
        expect(self.entry('quote-null').get_by_role('blockquote')).to_contain_text(record['text'])
        self.assertEqual(self.stored(),before)
        self.reply('null-media');self.send('引用返信も保存')
        reply=self.stored()[0]['progressHistory'][-1]
        self.assertEqual(reply['quote']['text'],record['text'])
        self.entry('null-media').get_by_role('button',name='コメントを編集',exact=True).click()
        self.page.get_by_label('コメントの編集',exact=True).fill('取り消す編集')
        self.page.get_by_role('button',name='編集をキャンセル',exact=True).click()
        self.assertIsNone(self.stored()[0]['progressHistory'][0]['images'])
        dialog=self.open_report(start=TODAY.isoformat(),end=TODAY.isoformat())
        _,body=self.download_report(dialog)
        self.assertIn(record['text'],body)
        self.assertEqual(self.errors,[])

    def test_task_card_click_handles_incomplete_optional_media_fields(self):
        image=dict(id='valid-image',name='残す画像.png',src='data:image/png;base64,'+__import__('base64').b64encode(self.progress_png()).decode())
        link=dict(id='valid-link',label='残すリンク',url='https://example.com/keep')
        variants=[(None,None),('',{}),([None,image],[None,link])]
        for images,links in variants:
            with self.subTest(images=type(images).__name__,links=type(links).__name__):
                record=dict(id='legacy-media',kind='comment',text='古いデータのトーク',status='active',createdAt=TODAY.isoformat()+'T01:00:00Z',subtaskIds=[],subtaskTitles=[],images=images,links=links)
                self.seed([task(progressEnabled=True,progressStage='doing',progressHistory=[record])]);self.progress()
                before=self.stored()
                self.card().click(position={'x':5,'y':5})
                expect(self.page.get_by_role('log',name='進捗履歴')).to_be_visible()
                expect(self.entry('legacy-media')).to_contain_text(record['text'])
                self.select_chat()
                expect(self.entry('legacy-media')).to_be_visible()
                if isinstance(images,list):
                    expect(self.entry('legacy-media').get_by_role('img',name='残す画像.png',exact=True)).to_be_visible()
                    expect(self.entry('legacy-media').get_by_role('link',name='残すリンク',exact=True)).to_have_attribute('href',link['url'])
                self.assertEqual(self.stored(),before)
                self.assertEqual(self.errors,[])

    def test_thread_render_error_keeps_cards_and_recovers_on_another_selection(self):
        broken=task(progressEnabled=True,progressStage='doing',progressHistory=[dict(id='bad',kind='comment',text={'invalid':'saved-object'},status='active',subtaskIds=[],subtaskTitles=[])])
        healthy=task('healthy',progressEnabled=True,progressStage='doing',progressHistory=[dict(id='good',kind='comment',text='正常なトーク',status='active',subtaskIds=[],subtaskTitles=[])])
        self.seed([broken,healthy]);self.progress()
        before=self.stored()
        self.card().click(position={'x':5,'y':5})
        expect(self.page.get_by_role('alert')).to_contain_text('このトークを表示できませんでした。')
        expect(self.page.get_by_role('heading',name='TaskMatrix Pro',exact=True)).to_be_visible()
        expect(self.card('healthy')).to_be_visible()
        self.page.get_by_text('エラーの詳細',exact=True).click()
        expect(self.page.get_by_role('alert')).to_contain_text('Objects are not valid as a React child')
        self.card('healthy').click(position={'x':5,'y':5})
        expect(self.page.get_by_role('log',name='進捗履歴')).to_contain_text('正常なトーク')
        expect(self.page.get_by_role('alert')).to_have_count(0)
        self.assertEqual(self.stored(),before)
        # React development builds may report the intentionally caught error.
        self.assertTrue(all('Objects are not valid as a React child' in error for error in self.errors))
        self.errors.clear()

    def test_card_click_with_legacy_host_hook_bindings(self):
        # The deployed Babel host exposes the four original bare hooks only.
        # Do not auto-add every named import as the normal test harness does.
        self.source=re.sub(r'const \{[^}]+\} = React;', 'const { useState, useEffect, useMemo, useRef } = React;',self.source,count=1)
        self.page.reload()
        expect(self.page.get_by_role('heading',name='TaskMatrix Pro',exact=True)).to_be_visible(timeout=15000)
        self.assertEqual(self.page.evaluate('typeof useLayoutEffect'),'undefined')
        original=task(progressEnabled=True,progressStage='doing',progressHistory=[
            dict(id='root-note',kind='comment',text='タスク全体のトーク',status='active',subtaskIds=[],subtaskTitles=[]),
            dict(id='small-note',kind='comment',text='小さいタスクのトーク',status='active',subtaskIds=['s1'],subtaskTitles=['既存の調査'],smallTaskId='a')])
        original['subtasks'][0]['smallTasks']=[dict(id='a',title='確認作業')]
        self.seed([original]);self.progress()
        self.card().click(position={'x':5,'y':5})
        expect(self.page.get_by_role('log',name='進捗履歴')).to_contain_text('タスク全体のトーク')
        expect(self.page.get_by_role('alert')).to_have_count(0)
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
        expect(self.page.get_by_role('log',name='進捗履歴')).to_contain_text('小さいタスクのトーク')
        self.page.get_by_role('button',name='確認作業のトークを表示',exact=True).click()
        expect(self.page.get_by_role('log',name='進捗履歴')).to_contain_text('小さいタスクのトーク')
        expect(self.page.get_by_role('log',name='進捗履歴')).not_to_contain_text('タスク全体のトーク')
        expect(self.page.get_by_role('heading',name='TaskMatrix Pro',exact=True)).to_be_visible()
        self.assertEqual(self.errors,[])

    def test_waiting_reply_preserves_blue_source_and_green_followup(self):
        for scope in ['task','parent','small']:
            with self.subTest(scope=scope):
                source=dict(id='wait-source',kind='comment',createdAt='2026-11-01T01:00:00Z',text='確認の回答を待つ',status='waiting',
                            subtaskIds=[] if scope=='task' else ['s1'],subtaskTitles=[] if scope=='task' else ['既存の調査'])
                if scope=='small': source.update(smallTaskId='a',smallTaskTitle='確認作業')
                original=task(progressEnabled=True,progressStage='doing',waiting=scope=='task',progressHistory=[source])
                if scope=='parent': original['subtasks'][0]['waiting']=True
                if scope=='small': original['subtasks'][0]['smallTasks']=[dict(id='a',title='確認作業',waiting=True)]
                self.seed([original]);self.progress();self.select_chat();self.reply('wait-source')
                self.page.get_by_label('相手待ち',exact=True).check();self.send('追加で回答を依頼中')
                result=self.stored()[0];self.assertEqual(len(result['progressHistory']),2)
                previous,followup=result['progressHistory']
                self.assertEqual(previous['text'],source['text']);self.assertEqual(previous['createdAt'],source['createdAt'])
                self.assertEqual(previous['resolvedByReplyId'],followup['id'])
                expect(self.entry('wait-source').locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))
                expect(self.entry(followup['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-green-50\b'))
                self.page.reload();self.progress();self.select_chat()
                expect(self.entry('wait-source').locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))
                self.page.get_by_role('button',name='進捗テスト案件の相手待ち一覧',exact=True).click()
                dialog=self.page.get_by_role('dialog',name='相手待ちステータス一覧',exact=True)
                expect(dialog).to_contain_text('追加で回答を依頼中');expect(dialog).not_to_contain_text('確認の回答を待つ')
                dialog.get_by_role('button',name='閉じる',exact=True).click()

    def test_completed_small_conversation_stacks_but_card_opens_normal_talks(self):
        self.seed([task(progressEnabled=True,progressStage='doing')]);self.progress();self.select_chat()
        self.page.get_by_label('関連: 既存の調査',exact=True).check();self.page.get_by_label('小さいタスクの追加',exact=True).check();self.send('まとめる作業')
        created=self.stored()[0]['progressHistory'][0];small_id=created['smallTaskId']
        self.page.get_by_role('button',name='まとめる作業のトークを表示',exact=True).click();self.reply(created['id']);self.send('途中の確認記録')
        midway=self.stored()[0]['progressHistory'][-1]
        self.page.get_by_label('完了',exact=True).check();self.send('結論はOK https://example.com/result')
        result=self.stored()[0];conclusion=result['progressHistory'][-1]
        self.assertIn(created,result['progressHistory']);self.assertEqual(len(result['progressHistory']),3)
        expect(self.page.locator('[data-progress-small-task-id="'+small_id+'"]')).to_have_class(re.compile(r'\bbg-blue-50\b'))
        expect(self.entry(midway['id'])).to_be_visible()
        self.select_chat()
        group=self.page.locator('[data-completed-small-task-id="'+small_id+'"]')
        expect(group).to_be_visible();expect(group.locator('[data-small-task-conclusion]')).to_have_text(conclusion['text'])
        expect(group.get_by_role('link',name='https://example.com/result',exact=True)).to_have_attribute('href','https://example.com/result')
        expect(self.entry(created['id'])).to_be_visible();expect(self.entry(midway['id'])).to_have_count(0)
        expand=group.get_by_role('button',name='まとめる作業の完了済みトークを展開',exact=True)
        expect(expand).to_have_attribute('aria-expanded','false');expand.click()
        expect(self.entry(midway['id'])).to_be_visible();expect(self.entry(conclusion['id'])).to_be_visible()
        self.entry(midway['id']).get_by_role('button',name='引用元へ移動: まとめる作業',exact=True).click()
        expect(self.entry(created['id'])).to_be_focused()
        group.get_by_role('button',name='まとめる作業の完了済みトークを折りたたむ',exact=True).click()
        expect(self.entry(midway['id'])).to_have_count(0)
        self.page.get_by_role('button',name='まとめる作業のトークを表示',exact=True).click()
        expect(self.page.locator('[data-completed-small-task-id]')).to_have_count(0)
        for record in [created,midway,conclusion]: expect(self.entry(record['id'])).to_be_visible()
        with self.page.expect_download() as download: self.page.get_by_role('button',name='エクスポート',exact=True).click()
        saved=Path(download.value.path()).read_bytes()
        self.seed([]);self.page.get_by_label('バックアップをインポート',exact=True).set_input_files(dict(name='stacked-talks.json',mimeType='application/json',buffer=saved))
        self.progress();self.select_chat();expect(group).to_be_visible()
        self.assertEqual(self.stored()[0]['progressHistory'],result['progressHistory'])

    def test_edit_completion_and_retraction_updates_group_card_and_dependencies(self):
        source=dict(id='origin',kind='comment',createdAt='2026-11-01T01:00:00Z',text='作業A',status='active',addedSmallTask=True,smallTaskId='a',smallTaskTitle='作業A',subtaskIds=['s1'],subtaskTitles=['既存の調査'])
        note=dict(source,id='progress',text='作業の記録',addedSmallTask=False)
        original=task(progressEnabled=True,progressStage='doing',progressHistory=[source,note])
        original['subtasks'][0]['smallTasks']=[dict(id='a',title='作業A'),dict(id='b',title='作業B',dependencies=[dict(kind='small',parentId='s1',id='a',title='作業A')])]
        self.seed([original]);self.progress();self.select_chat()
        self.entry('progress').get_by_role('button',name='コメントを編集',exact=True).click()
        self.page.get_by_label('完了',exact=True).check();self.page.get_by_label('コメントの編集',exact=True).fill('編集で完了した結論')
        self.page.get_by_role('button',name='編集を保存',exact=True).click()
        group=self.page.locator('[data-completed-small-task-id="a"]');expect(group).to_be_visible()
        expect(group.locator('[data-small-task-conclusion]')).to_have_text('編集で完了した結論')
        expect(self.page.locator('[data-progress-small-task-id="b"]')).to_have_class(re.compile(r'\bbg-purple-50\b'))
        group.get_by_role('button',name='結論を編集',exact=True).click()
        self.page.get_by_label('完了',exact=True).uncheck();self.page.get_by_role('button',name='編集を保存',exact=True).click()
        expect(group).to_have_count(0)
        expect(self.page.locator('[data-progress-small-task-id="a"]')).to_have_class(re.compile(r'\bbg-purple-50\b'))
        expect(self.page.locator('[data-progress-small-task-id="b"]')).to_have_class(re.compile(r'\bbg-yellow-50\b'))
        self.assertNotIn('a',self.stored()[0].get('completedSmallTaskIds',[]))
        self.page.reload();self.progress();self.select_chat();expect(group).to_have_count(0)
        self.assertFalse(self.stored()[0]['subtasks'][0]['smallTasks'][0]['completed'])
        self.entry('progress').get_by_role('button',name='コメントを編集',exact=True).click()
        self.page.get_by_label('完了',exact=True).check();self.page.get_by_role('button',name='編集を保存',exact=True).click()
        expect(group).to_be_visible()

    def test_retracting_latest_small_completion_reopens_closed_ancestors(self):
        def record(id,text,status='completed',**extra): return dict(id=id,text=text,kind='comment',createdAt='2026-11-01T01:00:00Z',status=status,smallTaskId='a',smallTaskTitle='作業A',subtaskIds=['s1'],subtaskTitles=['既存の調査'],**extra)
        records=[record('origin','作業A','active',addedSmallTask=True),record('old1','昔の結論'),record('old2','前回の結論'),record('latest','現在の結論')]
        original=task(progressEnabled=True,progressStage='doing',completedAt='2026-11-01T01:00:00Z',progressHistory=records,completedSmallTaskIds=['a'])
        original['completed']=True
        original['subtasks'][0].update(completed=True,completedAt='2026-11-01T01:00:00Z',smallTasks=[dict(id='a',title='作業A',completed=True,completionManaged=True,completionEntryId='latest',completionConclusion=records[-1])])
        self.seed([original]);self.progress();self.page.get_by_role('button',name='作業Aのトークを表示',exact=True).click()
        self.entry('old2').get_by_role('button',name='コメントを編集',exact=True).click()
        self.page.get_by_label('コメントの編集',exact=True).fill('過去の結論の本文だけを補足');self.page.get_by_role('button',name='編集を保存',exact=True).click()
        self.assertTrue(self.stored()[0]['subtasks'][0]['smallTasks'][0]['completed'])
        self.entry('latest').get_by_role('button',name='コメントを編集',exact=True).click()
        self.page.get_by_label('完了',exact=True).uncheck();self.page.get_by_role('button',name='編集を保存',exact=True).click()
        result=self.stored()[0]
        self.assertFalse(result['completed']);self.assertNotIn('completedAt',result)
        self.assertFalse(result['subtasks'][0]['completed']);self.assertFalse(result['subtasks'][0]['smallTasks'][0]['completed'])
        self.assertEqual(next(item for item in result['progressHistory'] if item['id']=='old1')['status'],'completed')
        expect(self.entry('old1').locator(':scope > div')).to_have_class(re.compile(r'\bbg-purple-50\b'))
        expect(self.entry('latest').locator(':scope > div')).to_have_class(re.compile(r'\bbg-purple-50\b'))
        self.page.reload();self.progress();self.select_chat()
        self.assertFalse(self.stored()[0]['subtasks'][0]['smallTasks'][0]['completed'])
        expect(self.page.locator('[data-progress-small-task-id="a"]')).to_have_class(re.compile(r'\bbg-purple-50\b'))

    def test_pasted_text_urls_are_clickable_in_talks_quotes_and_conclusions(self):
        self.seed([task(progressEnabled=True,progressStage='doing')]);self.progress();self.select_chat()
        self.ctx.grant_permissions(['clipboard-read','clipboard-write'])
        value='資料 https://example.com/spec?x=1&y=2。 (https://example.org/manual_(v2)). www.example.net/guide （HTTPS://example.com/ja）。 WWW.example.org javascript:alert(1)'
        self.page.evaluate('text=>navigator.clipboard.writeText(text)',value)
        self.page.get_by_label('進捗コメント',exact=True).press('Control+v')
        expect(self.page.get_by_label('進捗コメント',exact=True)).to_have_text(value)
        expect(self.page.get_by_label('進捗コメント',exact=True).get_by_role('link')).to_have_count(5)
        self.page.get_by_role('button',name='送信',exact=True).click()
        record=self.stored()[0]['progressHistory'][-1]
        self.assertEqual(record['text'],value)
        for label,href in [('https://example.com/spec?x=1&y=2','https://example.com/spec?x=1&y=2'),('https://example.org/manual_(v2)','https://example.org/manual_(v2)'),('www.example.net/guide','https://www.example.net/guide'),('HTTPS://example.com/ja','https://example.com/ja'),('WWW.example.org','https://www.example.org/')]:
            link=self.entry(record['id']).get_by_role('link',name=label,exact=True)
            expect(link).to_have_attribute('href',href);expect(link).to_have_attribute('rel','noopener noreferrer')
        expect(self.entry(record['id']).get_by_role('link')).to_have_count(5)
        self.reply(record['id']);self.send('引用して確認')
        latest=self.stored()[0]['progressHistory'][-1]
        expect(self.entry(latest['id']).get_by_role('blockquote').get_by_role('link')).to_have_count(5)

    def test_native_image_clipboard_pastes_into_composer_preview(self):
        self.seed([task(progressEnabled=True,progressStage='doing')]);self.progress();self.select_chat()
        expect(self.page.get_by_label('トークに画像を添付',exact=True)).to_have_count(0)
        expect(self.page.get_by_label('トークに添付するリンク',exact=True)).to_have_count(0)
        expect(self.page.get_by_role('button',name='リンクを添付',exact=True)).to_have_count(0)
        self.ctx.grant_permissions(['clipboard-read','clipboard-write'])
        self.page.evaluate('''async bytes=>{await navigator.clipboard.write([new ClipboardItem({'image/png':new Blob([new Uint8Array(bytes)],{type:'image/png'})})])}''',list(self.progress_png()))
        self.page.get_by_label('進捗コメント',exact=True).press('Control+v')
        preview=self.page.get_by_label('本文の添付プレビュー',exact=True)
        expect(preview.get_by_role('img')).to_be_visible()
        self.assertEqual(preview.get_by_role('img').evaluate('el=>el.naturalWidth'),1)
        self.page.get_by_role('button',name='送信',exact=True).click()
        record=self.stored()[0]['progressHistory'][-1]
        self.assertEqual(len(record['images']),1)
        expect(self.entry(record['id']).get_by_role('img')).to_be_visible()

    def test_quick_consecutive_image_pastes_keep_both_images(self):
        self.seed([task(progressEnabled=True,progressStage='doing')]);self.progress();self.select_chat()
        self.page.evaluate('''bytes=>{
          const read=FileReader.prototype.readAsDataURL;
          FileReader.prototype.readAsDataURL=function(file){setTimeout(()=>read.call(this,file),300)};
          const textarea=document.querySelector('[aria-label="進捗コメント"]');
          for(const name of ['first.png','second.png']){
            const clipboard=new DataTransfer();clipboard.items.add(new File([new Uint8Array(bytes)],name,{type:'image/png'}));
            textarea.dispatchEvent(new ClipboardEvent('paste',{clipboardData:clipboard,bubbles:true,cancelable:true}));
          }
        }''',list(self.progress_png()))
        expect(self.page.get_by_role('button',name='送信',exact=True)).to_be_disabled()
        expect(self.page.get_by_label('本文の添付プレビュー',exact=True).get_by_role('img')).to_have_count(2)
        expect(self.page.get_by_role('button',name='送信',exact=True)).to_be_enabled()
        self.page.get_by_role('button',name='送信',exact=True).click()
        self.assertEqual([image['name'] for image in self.stored()[0]['progressHistory'][-1]['images']],['first.png','second.png'])

    def test_todo_creation_is_bundled_before_completion_and_turns_blue(self):
        self.seed([task(progressEnabled=True,progressStage='doing')]);self.progress();self.select_chat()
        self.page.get_by_label('やるべきことの追加',exact=True).check();self.send('成果物を確認')
        created=self.stored()[0]['progressHistory'][-1];todo_id=created['subtaskIds'][0]
        self.assertTrue(created['addedSubtask']);self.assertEqual(created['text'],FUTURE+'までに【成果物を確認】')
        group=self.page.locator('[data-todo-thread-id="'+todo_id+'"]')
        expect(group).to_be_visible();expect(self.entry(created['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-purple-50\b'))
        expect(group.get_by_role('button',name='成果物を確認のトークを展開',exact=True)).to_have_attribute('aria-expanded','false')
        self.page.get_by_role('button',name='成果物を確認のトークを表示',exact=True).click();self.send('着手時の記録')
        note=self.stored()[0]['progressHistory'][-1]
        expect(self.entry(note['id'])).to_have_count(0)
        group.get_by_role('button',name='成果物を確認のトークを展開',exact=True).click();expect(self.entry(note['id'])).to_be_visible()
        self.page.get_by_label('小さいタスクの追加',exact=True).check();self.send('子の照合')
        small=self.stored()[0]['progressHistory'][-1]
        self.page.get_by_role('button',name='子の照合のトークを表示',exact=True).click();self.page.get_by_label('完了',exact=True).check();self.send('子の結論')
        self.page.get_by_role('button',name='成果物を確認のトークを表示',exact=True).click()
        nested=group.locator('[data-completed-small-task-id="'+small['smallTaskId']+'"]')
        expect(nested).to_be_visible();expect(nested.locator('[data-small-task-conclusion]')).to_have_text('子の結論')
        expect(self.entry(created['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-purple-50\b'))
        self.page.get_by_role('button',name='成果物を確認を完了',exact=True).click()
        completed=self.stored()[0]['progressHistory'][-1]
        expect(self.entry(created['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))
        self.entry(completed['id']).get_by_role('button',name='コメントを編集',exact=True).click();self.page.get_by_label('完了',exact=True).uncheck()
        self.page.get_by_role('button',name='編集を保存',exact=True).click()
        expect(self.entry(created['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-purple-50\b'))
        self.page.reload();self.progress();self.select_chat()
        expect(group).to_be_visible();expect(group.get_by_role('button',name='成果物を確認のトークを展開',exact=True)).to_have_attribute('aria-expanded','false')
        self.assertEqual(self.stored()[0]['progressHistory'][0],created)

    def test_completion_reply_adding_next_work_edits_the_original_small_only(self):
        for next_kind in ['小さいタスクの追加','やるべきことの追加']:
            with self.subTest(next_kind=next_kind):
                origin=dict(id='original',kind='comment',text='返答を待つ元作業',createdAt='2026-11-01T01:00:00Z',status='waiting',addedSmallTask=True,smallTaskId='old',smallTaskTitle='元作業',subtaskIds=['s1'],subtaskTitles=['既存の調査'])
                original=task(progressEnabled=True,progressStage='doing',progressHistory=[origin])
                original['subtasks'][0]['smallTasks']=[dict(id='old',title='元作業',waiting=True,completed=False)]
                self.seed([original]);self.progress();self.select_chat();self.reply('original')
                self.page.get_by_label('完了',exact=True).check();self.page.get_by_label(next_kind,exact=True).check();self.send('次の作業')
                record=self.stored()[0]['progressHistory'][-1]
                self.assertEqual(record['completedSmallTaskId'],'old')
                self.page.get_by_role('button',name='元作業のトークを表示',exact=True).click()
                expect(self.entry(record['id'])).to_be_visible()
                self.entry(record['id']).get_by_role('button',name='コメントを編集',exact=True).click()
                self.page.get_by_label('コメントの編集',exact=True).fill('結論の補足');self.page.get_by_role('button',name='編集を保存',exact=True).click()
                result=self.stored()[0]
                next_work=result['subtasks'][0]['smallTasks'][-1] if next_kind=='小さいタスクの追加' else result['subtasks'][-1]
                self.assertFalse(next_work['completed']);self.assertTrue(result['subtasks'][0]['smallTasks'][0]['completed'])
                self.entry(record['id']).get_by_role('button',name='コメントを編集',exact=True).click();self.page.get_by_label('完了',exact=True).uncheck()
                self.page.get_by_role('button',name='編集を保存',exact=True).click()
                self.assertFalse(self.stored()[0]['subtasks'][0]['smallTasks'][0]['completed'])
                self.page.reload();self.progress();self.page.get_by_role('button',name='元作業のトークを表示',exact=True).click()
                self.assertFalse(self.stored()[0]['subtasks'][0]['smallTasks'][0]['completed'])
                self.entry(record['id']).get_by_role('button',name='コメントを編集',exact=True).click();self.page.get_by_label('完了',exact=True).check()
                self.page.get_by_role('button',name='編集を保存',exact=True).click()
                self.assertTrue(self.stored()[0]['subtasks'][0]['smallTasks'][0]['completed'])

    def test_resolved_waiting_display_setting_hides_without_deleting_and_persists(self):
        source=dict(id='waiting',kind='comment',text='非表示を選べる回答待ち https://example.com/wait',createdAt='2026-11-01T01:00:00Z',status='waiting',subtaskIds=['s1'],subtaskTitles=['既存の調査'])
        original=task(progressEnabled=True,progressStage='doing',progressHistory=[source]);original['subtasks'][0]['waiting']=True
        self.seed([original]);self.progress();self.select_chat();self.reply('waiting');self.page.get_by_label('相手待ち',exact=True).check();self.send('次の回答を依頼')
        before=self.stored();reply=before[0]['progressHistory'][-1]
        option=self.page.get_by_label('返信済みの相手待ちの表示',exact=True)
        expect(option).to_have_value('show');option.select_option('hide')
        expect(self.entry('waiting')).to_have_count(0);expect(self.entry(reply['id'])).to_be_visible()
        expect(self.entry(reply['id']).get_by_role('blockquote').get_by_role('link')).to_have_attribute('href','https://example.com/wait')
        self.assertEqual(self.stored(),before)
        self.page.reload();self.progress();self.select_chat()
        expect(option).to_have_value('hide');expect(self.entry('waiting')).to_have_count(0)
        self.page.get_by_role('button',name='ボード',exact=True).click();self.progress();self.select_chat();expect(option).to_have_value('hide')
        option.select_option('show');expect(self.entry('waiting').locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))
        self.assertEqual(self.stored(),before)

    def test_hidden_waiting_origin_stays_hidden_in_completed_small_summary_and_flat_scope(self):
        source=dict(id='origin',kind='comment',text='隠す追加時の回答依頼',createdAt='2026-11-01T01:00:00Z',status='waiting',addedSmallTask=True,smallTaskId='small',smallTaskTitle='照合',subtaskIds=['s1'],subtaskTitles=['既存の調査'])
        original=task(progressEnabled=True,progressStage='doing',progressHistory=[source]);original['subtasks'][0]['smallTasks']=[dict(id='small',title='照合',waiting=True)]
        self.seed([original]);self.progress();self.select_chat();self.reply('origin');self.page.get_by_label('完了',exact=True).check();self.send('照合の結論')
        before=self.stored();conclusion=before[0]['progressHistory'][-1]
        self.page.get_by_label('返信済みの相手待ちの表示',exact=True).select_option('hide')
        expect(self.entry('origin')).to_have_count(0)
        group=self.page.locator('[data-completed-small-task-id="small"]');expect(group).to_be_visible()
        group.get_by_role('button',name='照合の完了済みトークを展開',exact=True).click()
        expect(self.entry('origin')).to_have_count(0);expect(self.entry(conclusion['id'])).to_be_visible()
        self.page.get_by_role('button',name='照合のトークを表示',exact=True).click()
        expect(group).to_have_count(0);expect(self.entry('origin')).to_have_count(0);expect(self.entry(conclusion['id'])).to_be_visible()
        self.page.get_by_label('返信済みの相手待ちの表示',exact=True).select_option('show')
        expect(self.entry('origin').locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))
        self.assertEqual(self.stored(),before)

    def test_settings_todo_addition_records_one_origin_and_refreshes_its_heading(self):
        self.seed([task(progressEnabled=True,progressStage='doing')]);self.progress();self.select_chat()
        self.card().get_by_role('button',name='進捗テスト案件の設定',exact=True).click()
        dialog=self.page.get_by_role('dialog',name='進捗の設定',exact=True)
        dialog.get_by_label('新しいやるべきこと',exact=True).fill('設定で追加')
        dialog.get_by_label('新しいやるべきことの期限',exact=True).fill(LATER)
        dialog.get_by_role('button',name='確定',exact=True).click()
        result=self.stored()[0];self.assertEqual(len(result['progressHistory']),1)
        origin=result['progressHistory'][0]
        self.assertEqual(origin['text'],LATER+'までに【設定で追加】')
        expect(self.page.locator('[data-todo-thread-id="'+origin['subtaskIds'][0]+'"]')).to_be_visible()
        self.card().get_by_role('button',name='進捗テスト案件の設定',exact=True).click()
        dialog.get_by_label('やるべきこと 3',exact=True).fill('名前を変更')
        dialog.get_by_label('やるべきこと 3 の期限',exact=True).fill(FUTURE)
        dialog.get_by_role('button',name='確定',exact=True).click()
        expect(self.entry(origin['id'])).to_contain_text(FUTURE+'までに【名前を変更】')
        self.assertEqual(self.stored()[0]['progressHistory'],[origin])

    def paste_rich_link(self,html,plain='資料'):
        self.ctx.grant_permissions(['clipboard-read','clipboard-write'])
        self.page.evaluate('''async ({html,plain})=>navigator.clipboard.write([new ClipboardItem({'text/html':new Blob([html],{type:'text/html'}),'text/plain':new Blob([plain],{type:'text/plain'})})])''',dict(html=html,plain=plain))
        self.page.get_by_label('進捗コメント',exact=True).press('Control+v')

    def test_pasted_named_hyperlink_is_inline_before_send_and_survives_edit_quote_backup(self):
        self.seed([task(progressEnabled=True,progressStage='doing')]);self.progress();self.select_chat()
        self.paste_rich_link('<a href="https://example.com/spec?rev=2">製品仕様書</a>','製品仕様書')
        box=self.page.get_by_label('進捗コメント',exact=True)
        expect(box.get_by_role('link',name='製品仕様書',exact=True)).to_have_attribute('href','https://example.com/spec?rev=2')
        expect(box).to_have_text(re.compile('^製品仕様書'))
        box.press('Control+Enter')
        source=self.stored()[0]['progressHistory'][-1]
        self.assertEqual(source['text'],'製品仕様書');self.assertEqual(source['textLinks'],[dict(start=0,end=5,url='https://example.com/spec?rev=2')])
        expect(self.entry(source['id']).get_by_role('link',name='製品仕様書',exact=True)).to_have_attribute('href','https://example.com/spec?rev=2')
        self.reply(source['id']);self.send('資料を確認')
        reply=self.stored()[0]['progressHistory'][-1]
        self.assertEqual(reply['quote']['textLinks'],source['textLinks'])
        self.entry(source['id']).get_by_role('button',name='コメントを編集',exact=True).click()
        editor=self.page.get_by_label('コメントの編集',exact=True)
        expect(editor.get_by_role('link',name='製品仕様書',exact=True)).to_be_visible()
        editor.fill('取り消す変更');self.page.get_by_role('button',name='編集をキャンセル',exact=True).click()
        self.assertEqual(self.stored()[0]['progressHistory'][0],source)
        self.page.get_by_label('履歴を検索',exact=True).fill('example.com/spec')
        expect(self.entry(source['id'])).to_be_visible();expect(self.entry(reply['id'])).to_be_visible()
        dialog=self.open_report(start=TODAY.isoformat(),end=TODAY.isoformat());_,body=self.download_report(dialog)
        self.assertIn('製品仕様書',body);self.assertIn('https://example.com/spec?rev=2',body)
        with self.page.expect_download() as download:self.page.get_by_role('button',name='エクスポート',exact=True).click()
        backup=Path(download.value.path()).read_bytes()
        self.seed([]);self.page.get_by_label('バックアップをインポート',exact=True).set_input_files(dict(name='inline-link.json',mimeType='application/json',buffer=backup))
        self.progress();self.select_chat()
        expect(self.entry(reply['id']).get_by_role('blockquote').get_by_role('link',name='製品仕様書',exact=True)).to_have_attribute('href','https://example.com/spec?rev=2')

    def test_link_paste_replaces_selection_and_following_typing_stays_outside_link(self):
        self.seed([task(progressEnabled=True,progressStage='doing')]);self.progress();self.select_chat()
        box=self.page.get_by_label('進捗コメント',exact=True);box.fill('前置換後')
        box.evaluate('''el=>{el.focus();const r=document.createRange();r.setStart(el.firstChild,1);r.setEnd(el.firstChild,3);getSelection().removeAllRanges();getSelection().addRange(r)}''')
        self.paste_rich_link('<a href="https://example.org/manual">説明書</a>','説明書')
        box.press('Control+z');expect(box).to_have_text('前置換後')
        box.press('Control+Shift+z');expect(box.get_by_role('link',name='説明書',exact=True)).to_be_visible()
        box.press_sequentially('追記')
        expect(box.get_by_role('link',name='説明書',exact=True)).to_have_text('説明書')
        box.press('Control+Enter')
        record=self.stored()[0]['progressHistory'][-1]
        self.assertEqual(record['text'],'前説明書追記後');self.assertEqual(record['textLinks'],[dict(start=1,end=4,url='https://example.org/manual')])

    def test_pasted_html_keeps_safe_links_without_scripts_images_or_markup(self):
        self.seed([task(progressEnabled=True,progressStage='doing')]);self.progress();self.select_chat()
        self.paste_rich_link('<script>window.pasteExecuted=true</script><style>body{display:none}</style><a href="javascript:alert(1)" onclick="window.pasteExecuted=true">危険なリンク</a><img src="https://outside.invalid/image" onerror="window.pasteExecuted=true"><a href="https://example.com/ok"><b>安全な資料</b></a>','危険なリンク 安全な資料')
        box=self.page.get_by_label('進捗コメント',exact=True)
        expect(box.get_by_role('link')).to_have_count(1);expect(box.get_by_role('img')).to_have_count(0)
        self.assertFalse(self.page.evaluate('!!window.pasteExecuted'))
        box.press('Control+Enter')
        record=self.stored()[0]['progressHistory'][-1]
        self.assertEqual(record['text'],'危険なリンク安全な資料');self.assertNotIn('<',record['text'])
        expect(self.entry(record['id']).get_by_role('link',name='安全な資料',exact=True)).to_have_attribute('href','https://example.com/ok')

    def test_rich_composer_preserves_typed_linebreaks_and_blank_lines(self):
        self.seed([task(progressEnabled=True,progressStage='doing')]);self.progress();self.select_chat()
        box=self.page.get_by_label('進捗コメント',exact=True)
        box.press_sequentially('1行目');box.press('Enter');box.press('Enter');box.press_sequentially('3行目');box.press('Shift+Enter');box.press_sequentially('4行目');box.press('Control+Enter')
        record=self.stored()[0]['progressHistory'][-1]
        self.assertEqual(record['text'],'1行目\n\n3行目\n4行目')
        self.entry(record['id']).get_by_role('button',name='コメントを編集',exact=True).click()
        editor=self.page.get_by_label('コメントの編集',exact=True)
        expect(editor).to_have_text(record['text'])
        self.page.get_by_role('button',name='編集を保存',exact=True).click()
        self.assertEqual(self.stored()[0]['progressHistory'][-1]['text'],record['text'])

    def test_legacy_completed_small_cards_return_and_any_talk_can_reopen_them(self):
        origin=dict(id='origin',kind='comment',text='なくなった作業',createdAt='2026-11-01T01:00:00Z',status='active',addedSmallTask=True,smallTaskId='lost',smallTaskTitle='復元する作業',subtaskIds=['s1'],subtaskTitles=['既存の調査'])
        older=dict(origin,id='older',text='前の結論',status='completed',addedSmallTask=False)
        latest=dict(origin,id='latest',text='現在の結論',status='completed',addedSmallTask=False,quote=origin,createdAt='2026-11-02T01:00:00Z')
        original=task(progressEnabled=True,progressStage='doing',progressHistory=[older,latest],completedSmallTaskIds=['lost'])
        self.seed([original]);self.progress()
        card=self.page.locator('[data-progress-small-task-id="lost"]');expect(card).to_have_class(re.compile(r'\bbg-blue-50\b'))
        card.click();expect(self.entry('origin')).to_be_visible()
        self.entry('origin').get_by_role('button',name='コメントを編集',exact=True).click()
        expect(self.page.get_by_label('完了',exact=True)).to_be_checked()
        self.page.get_by_label('完了',exact=True).uncheck();self.page.get_by_role('button',name='編集を保存',exact=True).click()
        expect(card).to_have_class(re.compile(r'\bbg-purple-50\b'))
        self.assertFalse(self.stored()[0]['subtasks'][0]['smallTasks'][0]['completed'])
        self.assertEqual(next(entry for entry in self.stored()[0]['progressHistory'] if entry['id']=='latest')['status'],'completed')
        self.page.reload();self.progress();expect(card).to_have_count(1);expect(card).to_have_class(re.compile(r'\bbg-purple-50\b'))
        card.click();self.page.get_by_label('完了',exact=True).check();self.send('あらためて完了')
        expect(card).to_have_class(re.compile(r'\bbg-blue-50\b'));self.assertEqual(self.page.locator('[data-progress-stage="doing"]').locator('[data-progress-small-task-id="lost"]').count(),1)
        self.page.get_by_role('button',name='復元する作業を削除',exact=True).click()
        expect(card).to_have_count(0);self.page.reload();self.progress();expect(card).to_have_count(0)

    def test_legacy_waiting_sources_and_missing_small_card_are_recovered(self):
        source=dict(id='wait-old',text='消えた相手待ちメッセージ',createdAt='2026-11-01T01:00:00Z',status='waiting',smallTaskId='old-small',smallTaskTitle='待っていた作業',subtaskIds=['s1'],subtaskTitles=['既存の調査'])
        reply=dict(id='reply',kind='comment',text='回答を受領',createdAt='2026-11-02T01:00:00Z',status='active',smallTaskId='old-small',smallTaskTitle='待っていた作業',subtaskIds=['s1'],subtaskTitles=['既存の調査'],quote=source)
        self.seed([task(progressEnabled=True,progressStage='doing',progressHistory=[reply])]);self.progress();self.select_chat()
        expect(self.entry('wait-old').locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))
        expect(self.page.locator('[data-progress-small-task-id="old-small"]')).to_have_class(re.compile(r'\bbg-purple-50\b'))
        restored=self.stored()[0];self.assertEqual(restored['progressHistory'][0]['resolvedByReplyId'],'reply')
        self.page.get_by_label('返信済みの相手待ちの表示',exact=True).select_option('hide');expect(self.entry('wait-old')).to_have_count(0)
        self.page.reload();self.progress();self.select_chat();expect(self.entry('wait-old')).to_have_count(0)
        self.page.get_by_label('返信済みの相手待ちの表示',exact=True).select_option('show');expect(self.entry('wait-old')).to_be_visible()
        self.assertEqual(self.stored()[0],restored)

    def test_legacy_todo_headers_show_deadline_and_title_without_inventing_dates(self):
        original=task(progressEnabled=True,progressStage='doing')
        original['subtasks'][1]['completed']=True
        self.seed([original]);self.progress();self.select_chat()
        first=self.page.locator('[data-todo-thread-id="s1"]');second=self.page.locator('[data-todo-thread-id="s2"]')
        expect(first).to_contain_text(FUTURE+'までに【既存の調査】');expect(second).to_contain_text(PAST+'までに【期限切れの確認】')
        expect(first.locator(':scope > div > div')).to_have_class(re.compile(r'\bbg-purple-50\b'))
        expect(second.locator(':scope > div > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))
        expect(first).to_contain_text('日時未記録');self.assertEqual(self.stored()[0],original)
        first.get_by_role('button',name='既存の調査のトークを折りたたむ',exact=True).click()
        expect(first.get_by_role('button',name='既存の調査のトークを展開',exact=True)).to_have_attribute('aria-expanded','false')
        self.page.reload();self.progress();self.select_chat();expect(first).to_contain_text(FUTURE+'までに【既存の調査】')
        self.assertEqual(self.stored()[0],original)

    def test_report_default_range_is_seven_days_ago_through_today(self):
        self.seed([task(progressEnabled=True)])
        self.page.get_by_role('button',name='レポート作成',exact=True).click()
        dialog=self.page.get_by_role('dialog',name='週報用レポート作成',exact=True)
        expect(dialog.get_by_label('レポート開始日',exact=True)).to_have_value((TODAY-timedelta(days=7)).isoformat())
        expect(dialog.get_by_label('レポート終了日',exact=True)).to_have_value(TODAY.isoformat())
        expect(dialog.get_by_role('checkbox')).to_have_count(1)

    def test_report_targets_use_completion_date_and_update_with_period(self):
        def completed(id,title,at=None,due='1999-01-01'):
            item=task(id,progressEnabled=True)
            item.update(title=title,completed=True,dueDate=due)
            if at is not None: item['completedAt']=at
            return item
        pending_old=task('pending-old',progressEnabled=True);pending_old.update(title='期限が昔でも未完了',dueDate='1999-01-01')
        pending_future=task('pending-future',progressEnabled=True);pending_future.update(title='期限が未来でも未完了',dueDate='2099-01-01')
        items=[pending_old,pending_future,
               completed('start-done','開始日ちょうどに完了','2026-10-18T15:00:00.000Z'),
               completed('end-done','終了日の最後に完了','2026-10-25T14:59:59.999Z'),
               completed('before-done','開始日前に完了','2026-10-18T14:59:59.999Z',due='2026-10-21'),
               completed('after-done','終了日後に完了','2026-10-25T15:00:00.000Z',due='2026-10-21'),
               completed('legacy-in','期限日代用の旧タスク',due='2026-10-20'),
               completed('legacy-out','期間外の期限を持つ旧タスク',due='2026-10-26'),
               completed('unknown','日付が両方ない完了タスク',due='')]
        self.seed(items);before=self.stored()
        dialog=self.open_report()
        expected=['期限が昔でも未完了','期限が未来でも未完了','開始日ちょうどに完了','終了日の最後に完了','期限日代用の旧タスク']
        names=dialog.get_by_role('checkbox').evaluate_all('elements => elements.map(el => el.getAttribute("aria-label"))')
        self.assertEqual(set(names),{'レポート対象: '+title for title in expected})
        expect(dialog.get_by_text('完了日時・期限日とも未記録の完了タスクは対象外です（1件）。',exact=True)).to_be_visible()
        dialog.get_by_role('button',name='表示中をすべて選択',exact=True).click()
        _,body=self.download_report(dialog)
        self.assertIn('期間内に完了したタスク: 3件',body)
        self.assertIn('うち期限日を完了日として扱ったタスク: 1件',body)
        self.assertIn('タスク全体の完了日: 2026-10-20（完了日時未記録のため期限日を使用）',body)
        for title in expected: self.assertIn(title,body)
        for title in ['開始日前に完了','終了日後に完了','期間外の期限を持つ旧タスク','日付が両方ない完了タスク']: self.assertNotIn(title,body)
        dialog=self.open_report()
        dialog.get_by_role('button',name='表示中をすべて選択',exact=True).click()
        dialog.get_by_label('レポート開始日',exact=True).fill('2026-10-26')
        dialog.get_by_label('レポート終了日',exact=True).fill('2026-11-01')
        for title in ['開始日ちょうどに完了','終了日の最後に完了','期限日代用の旧タスク']:
            expect(dialog.get_by_label('レポート対象: '+title,exact=True)).to_have_count(0)
        dialog.get_by_role('button',name='表示中をすべて選択',exact=True).click()
        _,later_body=self.download_report(dialog)
        self.assertIn('終了日後に完了',later_body)
        self.assertIn('期間外の期限を持つ旧タスク',later_body)
        self.assertNotIn('開始日ちょうどに完了',later_body)
        self.assertNotIn('終了日の最後に完了',later_body)
        self.assertEqual(self.stored(),before)

    def test_task_completion_timestamp_persists_and_reopen_refreshes_it(self):
        self.seed([task(progressEnabled=True)])
        card=self.page.locator('#task-track')
        before=self.page.evaluate('Date.now()')
        card.get_by_role('button',name='結論入力 / 完了',exact=True).click()
        self.page.get_by_role('button',name='タスク完了',exact=True).click()
        first=self.stored()[0]['completedAt']
        self.assertGreaterEqual(self.page.evaluate('value => Date.parse(value)',first),before)
        self.page.get_by_role('checkbox',name=re.compile('完了したタスク|完了を表示')).check()
        card.get_by_role('button',name='結論入力 / 完了',exact=True).click()
        self.page.get_by_role('button',name='保存のみ',exact=True).click()
        self.assertEqual(self.stored()[0]['completedAt'],first)
        dialog=self.open_report(start=TODAY.isoformat(),end=TODAY.isoformat())
        expect(dialog.get_by_label('レポート対象: 進捗テスト案件',exact=True)).to_be_visible()
        _,body=self.download_report(dialog)
        self.assertIn('期間内に完了したタスク: 1件',body)
        self.assertIn('タスク全体の完了日時:',body)
        with self.page.expect_download() as download:
            self.page.get_by_role('button',name='エクスポート',exact=True).click()
        backup=Path(download.value.path()).read_bytes()
        self.assertEqual(json.loads(backup)['tasks'][0]['completedAt'],first)
        self.seed([])
        self.page.get_by_label('バックアップをインポート',exact=True).set_input_files(dict(name='completion-backup.json',mimeType='application/json',buffer=backup))
        self.assertEqual(self.stored()[0]['completedAt'],first)
        self.page.reload()
        expect(self.page.get_by_role('heading',name='TaskMatrix Pro')).to_be_visible(timeout=15000)
        self.assertEqual(self.stored()[0]['completedAt'],first)
        self.page.get_by_role('checkbox',name=re.compile('完了したタスク|完了を表示')).check()
        card.get_by_role('button',name='結論入力 / 完了',exact=True).click()
        self.page.get_by_role('button',name='タスク完了を取り消す',exact=True).click()
        self.assertFalse(self.stored()[0]['completed'])
        self.assertNotIn('completedAt',self.stored()[0])
        card.get_by_role('button',name='結論入力 / 完了',exact=True).click()
        self.page.get_by_role('button',name='タスク完了',exact=True).click()
        second=self.stored()[0]['completedAt']
        self.assertGreater(self.page.evaluate('value => Date.parse(value)',second),self.page.evaluate('value => Date.parse(value)',first))

    def test_recurring_completion_uses_actual_day_not_scheduled_day(self):
        self.seed([])
        day=TODAY-timedelta(days=TODAY.weekday()+6)
        occurrence=day.isoformat()
        schedule=dict(id='completed-series',title='前の週の定期タスク',frequency='weekly',interval=1,dayOfWeek=day.weekday()+1,
                      startDate=occurrence,endDate=occurrence,memo='',urls=[])
        self.page.evaluate('''async schedule => {
          const db=await new Promise(resolve=>{const request=indexedDB.open('TaskMatrixAppDB',1);request.onsuccess=()=>resolve(request.result)});
          await new Promise(resolve=>{const tx=db.transaction('appData','readwrite');tx.objectStore('appData').put([schedule],'recurringSchedules');tx.oncomplete=resolve});db.close();
        }''',schedule)
        self.page.reload()
        expect(self.page.get_by_role('heading',name='TaskMatrix Pro')).to_be_visible(timeout=15000)
        card=self.page.locator('#task-rec_completed-series_'+occurrence)
        card.get_by_role('button',name='結論入力 / 完了',exact=True).click()
        self.page.get_by_role('button',name='タスク完了',exact=True).click()
        self.page.reload()
        expect(self.page.get_by_role('heading',name='TaskMatrix Pro')).to_be_visible(timeout=15000)
        dialog=self.open_report(start=TODAY.isoformat(),end=TODAY.isoformat())
        checkbox=dialog.get_by_label(f'レポート対象: 前の週の定期タスク ({occurrence})',exact=True)
        expect(checkbox).to_be_visible();checkbox.check()
        _,body=self.download_report(dialog)
        self.assertIn('タスク全体の完了日時: '+TODAY.isoformat(),body)
        self.assertIn('うち期限日を完了日として扱ったタスク: 0件',body)
        self.page.get_by_role('checkbox',name=re.compile('完了したタスク|完了を表示')).check()
        card.get_by_role('button',name='結論入力 / 完了',exact=True).click()
        self.page.get_by_role('button',name='タスク完了を取り消す',exact=True).click()
        dialog=self.open_report(start=TODAY.isoformat(),end=TODAY.isoformat())
        expect(checkbox).to_have_count(0)

    def test_weekly_report_filters_selected_tasks_and_inclusive_local_dates(self):
        history=[
            dict(id='before',createdAt='2026-10-18T14:59:59.999Z',text='OUTSIDE_BEFORE',status='active'),
            dict(id='start',createdAt='2026-10-18T15:00:00.000Z',text='週の開始時刻の進捗',status='active'),
            dict(id='complete',createdAt='2026-10-20T01:00:00.000Z',text='削除済み項目を完了した記録',status='completed',
                 smallTaskId='removed-small',smallTaskTitle='完了して削除された照合',
                 quote=dict(id='old-quote',createdAt='2026-10-10T01:00:00.000Z',text='期間外の依頼を背景として引用',status='waiting')),
            dict(id='end',createdAt='2026-10-25T14:59:59.999Z',text='週の終了時刻の回答待ち',status='waiting'),
            dict(id='after',createdAt='2026-10-25T15:00:00.000Z',text='OUTSIDE_AFTER',status='active'),
        ]
        for entry in history: entry.update(kind='comment',subtaskIds=['s1'],subtaskTitles=['既存の調査'])
        history.append(dict(id='deadline-report',kind='change',changeType='deadline',reason='顧客都合の延期',
                            createdAt='2026-10-21T01:00:00.000Z',text='期限を変更\n理由: 顧客都合の延期',subtaskIds=[],subtaskTitles=[]))
        history.append(dict(id='hidden-auto',kind='change',createdAt='2026-10-21T02:00:00.000Z',text='HIDDEN_AUTO_ADDITION'))
        self.seed([task(progressEnabled=True,progressStage='doing',progressHistory=history),
                   task('other',progressEnabled=True,progressHistory=[dict(id='excluded',kind='comment',createdAt='2026-10-20T01:00:00.000Z',text='EXCLUDED_TASK_CONTENT')])])
        before=self.stored()
        report_button=self.page.get_by_role('button',name='レポート作成',exact=True)
        self.assertIn('エクスポート',report_button.evaluate('el => el.previousElementSibling.textContent'))
        dialog=self.open_report()
        dialog.get_by_role('button',name='選択を解除',exact=True).click()
        dialog.get_by_label('レポート対象: 進捗テスト案件',exact=True).check()
        name,body=self.download_report(dialog)
        self.assertEqual(name,'週報素材_2026-10-19_2026-10-25.txt')
        for value in ['Copilotへの依頼','Asia/Tokyo','2026-10-19 00:00:00','2026-10-25 23:59:59',
                      '進捗記録: 3件','完了の記録: 1件','相手待ちの記録: 1件','理由付き期限変更の記録: 1件',
                      '顧客都合の延期','期間外の依頼を背景として引用','引用（背景資料・新規実績には数えない）',
                      '完了して削除された照合','現在の状態（出力時点）']:
            self.assertIn(value,body)
        for value in ['OUTSIDE_BEFORE','OUTSIDE_AFTER','HIDDEN_AUTO_ADDITION','EXCLUDED_TASK_CONTENT','対象外タスク']:
            self.assertNotIn(value,body)
        self.assertEqual(self.stored(),before)

    def test_weekly_report_rejects_invalid_dates_and_empty_selection(self):
        self.seed([])
        dialog=self.open_report()
        button=dialog.get_by_role('button',name='テキストをダウンロード',exact=True)
        expect(button).to_be_disabled()
        expect(dialog.get_by_text('対象タスクがありません。検索条件や期間を確認してください。',exact=True)).to_be_visible()
        dialog.get_by_role('button',name='キャンセル',exact=True).click()
        self.seed([task()])
        before=self.stored()
        dialog=self.open_report(start='2026-10-26',end='2026-10-20')
        expect(dialog.get_by_role('alert')).to_be_visible()
        expect(button).to_be_disabled()
        dialog.get_by_label('レポート終了日',exact=True).fill('2026-10-27')
        expect(button).to_be_enabled()
        dialog.get_by_role('button',name='選択を解除',exact=True).click()
        expect(button).to_be_disabled()
        dialog.get_by_role('button',name='表示中をすべて選択',exact=True).click()
        expect(button).to_be_enabled()
        dialog.get_by_label('レポート対象タスクを検索',exact=True).press('Escape')
        expect(dialog).to_have_count(0)
        self.assertEqual(self.stored(),before)

    def test_weekly_report_separates_undated_current_results_from_period_activity(self):
        original=task(progressEnabled=True)
        original.update(completed=True,completedAt='2000-01-03T01:00:00.000Z',completionNote='実施時期が不明の結果メモ',
                        richResult='<div>解析の結果<br>確認できた内容</div><script>window.reportScriptRan=1</script><img alt="測定結果" src="data:image/png;base64,DO_NOT_EXPORT_BINARY"><a href="https://example.test/result">成果リンク</a>',
                        resultUrls=['https://example.test/artifact'])
        self.seed([original])
        dialog=self.open_report(start='2000-01-01',end='2000-01-07')
        dialog.get_by_label('レポート対象: 進捗テスト案件',exact=True).check()
        _,body=self.download_report(dialog)
        for value in ['進捗記録: 0件','完了の記録: 0件','現在の状態（出力時点）: 完了','結果メモ（日時未記録・現在の保存内容）',
                      '実施時期が不明の結果メモ','解析の結果','確認できた内容','https://example.test/result','https://example.test/artifact','指定期間内の進捗記録はありません。']:
            self.assertIn(value,body)
        self.assertNotIn('<div>',body)
        self.assertNotIn('reportScriptRan',body)
        self.assertNotIn('DO_NOT_EXPORT_BINARY',body)
        self.assertIsNone(self.page.evaluate('window.reportScriptRan'))

    def test_weekly_report_selects_only_recurring_occurrence_in_date_range(self):
        self.seed([])
        week_start=TODAY-timedelta(days=TODAY.weekday())
        occurrence=(week_start+timedelta(days=1)).isoformat()
        following=(week_start+timedelta(days=8)).isoformat()
        schedule=dict(id='report-series',title='定期レビュー',frequency='weekly',interval=1,
                      dayOfWeek=2,startDate=week_start.isoformat(),endDate=following,memo='毎週の確認',urls=[])
        self.page.evaluate('''async data => {
          const db=await new Promise(resolve=>{const r=indexedDB.open('TaskMatrixAppDB',1);r.onsuccess=()=>resolve(r.result)});
          await new Promise(resolve=>{const tx=db.transaction('appData','readwrite');
            tx.objectStore('appData').put([data.schedule],'recurringSchedules');
            tx.objectStore('appData').put({[data.key]:{completed:true,completedAt:data.completedAt,completionNote:'定期回の現在の結果'}},'recurringCompletions');
            tx.oncomplete=resolve;});db.close();
        }''',dict(schedule=schedule,key='report-series_'+occurrence,completedAt=occurrence+'T01:00:00.000Z'))
        self.page.reload()
        expect(self.page.get_by_role('heading',name='TaskMatrix Pro')).to_be_visible(timeout=15000)
        dialog=self.open_report(start=week_start.isoformat(),end=(week_start+timedelta(days=6)).isoformat())
        expect(dialog.get_by_role('checkbox')).to_have_count(1)
        dialog.get_by_label(f'レポート対象: 定期レビュー ({occurrence})',exact=True).check()
        _,body=self.download_report(dialog)
        self.assertIn(f'定期予定（{occurrence} の回）',body)
        self.assertIn('現在の状態（出力時点）: 完了',body)
        self.assertIn('定期回の現在の結果',body)
        self.assertNotIn(f'定期予定（{following} の回）',body)

    def test_quote_navigation_reveals_and_focuses_existing_source(self):
        source=dict(id='jump-source',kind='comment',createdAt='2026-01-01T01:00:00.000Z',text='移動先の元コメント',status='active',subtaskIds=['s1'],subtaskTitles=['既存の調査'])
        reply=dict(id='jump-reply',kind='comment',createdAt='2026-01-02T01:00:00.000Z',text='検索で表示する返信',status='active',subtaskIds=['s2'],subtaskTitles=['期限切れの確認'],quote=source)
        self.seed([task(progressEnabled=True,progressStage='doing',progressHistory=[source,reply])])
        self.progress();self.select_chat()
        self.page.get_by_label('履歴を検索',exact=True).fill('検索で表示する返信')
        self.page.get_by_label('やるべきことで絞り込み',exact=True).select_option('s2')
        expect(self.entry(source['id'])).to_have_count(0)
        self.entry(reply['id']).get_by_role('button',name='引用元へ移動: 移動先の元コメント',exact=True).click()
        expect(self.page.get_by_label('履歴を検索',exact=True)).to_have_value('')
        expect(self.page.get_by_label('やるべきことで絞り込み',exact=True)).to_have_value('')
        expect(self.entry(source['id'])).to_be_visible()
        expect(self.entry(source['id'])).to_be_focused()
        expect(self.entry(source['id'])).to_have_class(re.compile(r'\bring-2\b'))

    def test_quote_navigation_displays_saved_source_after_deletion(self):
        quote=dict(id='deleted-jump-source',text='削除済みでも保存した元コメント',status='waiting',createdAt='2026-01-01T01:00:00.000Z',subtaskIds=['s1'],subtaskTitles=['既存の調査'])
        reply=dict(id='saved-jump',kind='comment',createdAt='2026-01-02T01:00:00.000Z',text='引用を保持する返信',status='active',subtaskIds=['s1'],subtaskTitles=['既存の調査'],quote=quote)
        self.seed([task(progressEnabled=True,progressStage='doing',progressHistory=[reply],deletedProgressEntryIds=[quote['id']])])
        self.progress();self.select_chat()
        before=self.stored()
        self.entry(reply['id']).get_by_role('button',name='引用元へ移動: 削除済みでも保存した元コメント',exact=True).click()
        dialog=self.page.get_by_role('dialog',name='引用元のコメント',exact=True)
        expect(dialog).to_contain_text(quote['text'])
        expect(dialog).to_contain_text('引用時に保存した内容')
        dialog.get_by_role('button',name='引用元の確認を閉じる',exact=True).press('Escape')
        expect(dialog).to_have_count(0)
        self.assertEqual(self.stored(),before)

    def test_waiting_comments_share_small_task_list_and_resolve_by_reply(self):
        source=dict(id='integrated-wait',kind='comment',createdAt='2026-01-01T01:00:00.000Z',
                    text='資料の回答待ち',status='waiting',subtaskIds=['s1'],subtaskTitles=['既存の調査'])
        original=task(progressEnabled=True,progressStage='doing',progressHistory=[source])
        original['subtasks'][0].update(waiting=True,smallTasks=[dict(id='small1',title='既存の小さい作業',completed=False)])
        self.seed([original]);self.progress();self.select_chat()
        row=self.page.locator('[data-progress-waiting-task-id="integrated-wait"]')
        expect(row).to_have_count(0)
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
        expect(row).to_have_count(0)
        expect(self.page.locator('[data-progress-subtask-id="s1"]')).to_have_class(re.compile(r'\bbg-green-50\b'))
        expect(self.page.locator('[data-progress-small-task-id="small1"]')).to_be_visible()
        self.assertEqual(self.stored()[0],original)
        self.reply(source['id'])
        expect(self.page.get_by_role('region',name='返信先',exact=True)).to_be_visible()
        self.send('回答を受領しました')
        expect(row).to_have_count(0)
        result=self.stored()[0]
        self.assertFalse(result['subtasks'][0]['waiting'])
        self.assertEqual(result['subtasks'][0]['smallTasks'],original['subtasks'][0]['smallTasks'])
        self.assertEqual(result['progressHistory'][-1]['quote']['id'],source['id'])
        expect(self.entry(source['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))
        expect(self.entry(result['progressHistory'][-1]['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-purple-50\b'))
        self.page.reload();self.progress();self.select_chat()
        expect(row).to_have_count(0)

    def test_task_level_waiting_is_visible_without_duplicate_nested_waiting(self):
        entries=[dict(id='global-wait',kind='comment',text='タスク全体の回答待ち',status='waiting',subtaskIds=[],subtaskTitles=[]),
                 dict(id='nested-wait',kind='comment',text='小さい作業の回答待ち',status='waiting',subtaskIds=['s1'],subtaskTitles=['既存の調査'],smallTaskId='small1',smallTaskTitle='小さい作業')]
        for entry in entries: entry['createdAt']='2026-01-01T01:00:00.000Z'
        original=task(progressEnabled=True,progressStage='doing',waiting=True,progressHistory=entries)
        original['subtasks'][0]['smallTasks']=[dict(id='small1',title='小さい作業',waiting=True,completed=False)]
        self.seed([original]);self.progress();self.select_chat()
        expect(self.page.locator('[data-progress-waiting-task-id]')).to_have_count(0)
        expect(self.card()).to_have_class(re.compile(r'\bbg-green-50\b'))
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
        expect(self.page.locator('[data-progress-small-task-id="small1"]')).to_have_count(1)
        expect(self.page.locator('[data-progress-small-task-id="small1"]')).to_have_class(re.compile(r'\bbg-green-50\b'))
        expect(self.page.locator('[data-progress-small-task-id="small1"]')).to_have_css('font-size','12px')
        expect(self.page.locator('[data-progress-waiting-task-id="nested-wait"]')).to_have_count(0)
        self.assertEqual(self.stored()[0],original)
        row=self.page.locator('[data-progress-waiting-task-id="global-wait"]')
        self.select_chat();self.reply('global-wait')
        expect(self.page.get_by_role('region',name='返信先',exact=True)).to_be_visible()
        self.entry('global-wait').get_by_role('button',name='コメントを削除',exact=True).click()
        expect(row).to_have_count(0)
        expect(self.page.get_by_role('region',name='返信先',exact=True)).to_have_count(0)
        self.assertTrue(self.stored()[0]['waiting'])
        self.assertEqual(self.stored()[0]['subtasks'],original['subtasks'])

    def test_small_task_list_reply_quotes_addition_and_completion_retains_source(self):
        original=task(progressEnabled=True,progressStage='doing',waiting=True)
        original['subtasks'][0]['waiting']=True
        self.seed([original]);self.progress();self.select_chat()
        self.page.get_by_label('関連: 既存の調査',exact=True).check()
        self.page.get_by_label('小さいタスクの追加',exact=True).check()
        self.send('返信で管理する小さい作業')
        stored=self.stored()[0]
        source=stored['progressHistory'][0]
        small=stored['subtasks'][0]['smallTasks'][0]
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
        row=self.page.locator('[data-progress-small-task-id="'+small['id']+'"]')
        row.click();self.reply(source['id'])
        preview=self.page.get_by_role('region',name='返信先',exact=True)
        expect(preview).to_contain_text(source['text'])
        self.send('途中の進捗です')
        self.assertEqual(len(self.stored()[0]['subtasks'][0]['smallTasks']),1)
        midway=self.stored()[0]['progressHistory'][-1]
        expect(self.entry(midway['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-purple-50\b'))
        expect(self.entry(source['id'])).to_be_visible()
        row.click();self.reply(source['id'])
        self.page.get_by_label('完了',exact=True).check()
        self.send('小さい作業が完了しました')
        result=self.stored()[0]
        self.assertTrue(result['subtasks'][0]['smallTasks'][0]['completed'])
        self.assertFalse(result['subtasks'][0]['completed'])
        self.assertTrue(result['subtasks'][0]['waiting'])
        self.assertTrue(result['waiting'])
        self.assertTrue(any(item['id']==source['id'] for item in result['progressHistory']))
        reply=result['progressHistory'][-1]
        self.assertEqual(reply['status'],'completed')
        self.assertEqual(reply['quote']['id'],source['id'])
        self.assertEqual(reply['quote']['text'],source['text'])
        self.assertEqual(reply['quote']['createdAt'],source['createdAt'])
        expect(self.entry(reply['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))
        expect(row).to_have_class(re.compile(r'\bbg-blue-50\b'))
        expect(self.entry(source['id'])).to_be_visible()
        self.page.reload();self.progress();row.click()
        expect(self.entry(reply['id']).get_by_role('blockquote',name='引用コメント')).to_contain_text(source['text'])

    def test_legacy_small_task_card_completes_without_quote_or_fake_date(self):
        original=task(progressEnabled=True,progressStage='doing')
        original['subtasks'][0]['smallTasks']=[dict(id='legacy-small',title='古い小さい項目',completed=False)]
        self.seed([original]);self.progress();self.select_chat()
        row=self.page.locator('[data-progress-small-task-id="legacy-small"]')
        row.get_by_role('button',name='古い小さい項目のトークを表示',exact=True).press('Enter')
        expect(self.page.get_by_role('region',name='返信先',exact=True)).to_have_count(0)
        self.page.get_by_label('完了',exact=True).check()
        self.send('古い小さい項目も完了')
        result=self.stored()[0]
        self.assertTrue(result['subtasks'][0]['smallTasks'][0]['completed'])
        self.assertFalse(result['subtasks'][0]['completed'])
        self.assertEqual(len(result['progressHistory']),1)
        self.assertEqual(result['progressHistory'][0]['smallTaskId'],'legacy-small')
        self.assertNotIn('quote',result['progressHistory'][0])
        self.page.reload();self.progress()
        self.page.get_by_role('button',name='古い小さい項目のトークを表示',exact=True).click()
        expect(self.entry(result['progressHistory'][0]['id'])).not_to_contain_text('Invalid Date')

    def test_task_level_waiting_reply_completion_retains_blue_record_without_completing_task(self):
        source=dict(id='global-complete',kind='comment',text='タスク全体の返答待ち',status='waiting',
                    createdAt='2026-01-01T01:00:00.000Z',subtaskIds=[],subtaskTitles=[])
        original=task(progressEnabled=True,progressStage='doing',waiting=True,progressHistory=[source])
        self.seed([original]);self.progress();self.select_chat()
        row=self.page.locator('[data-progress-waiting-task-id="global-complete"]')
        self.reply(source['id'])
        complete=self.page.get_by_label('完了',exact=True)
        expect(complete).to_be_enabled();complete.check()
        self.send('返答を受領し完了')
        result=self.stored()[0]
        self.assertFalse(result['waiting'])
        self.assertFalse(result['completed'])
        self.assertEqual(result['subtasks'],original['subtasks'])
        self.assertEqual(len(result['progressHistory']),2)
        reply=result['progressHistory'][-1]
        self.assertEqual(reply['status'],'completed')
        self.assertEqual(reply['quote']['text'],source['text'])
        expect(row).to_have_count(0)
        expect(self.entry(source['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))
        self.entry(reply['id']).get_by_role('button',name='コメントを編集',exact=True).click()
        expect(complete).to_be_checked()
        self.page.get_by_label('コメントの編集',exact=True).fill('完了記録の説明を補足')
        self.page.get_by_role('button',name='編集を保存',exact=True).click()
        self.assertEqual(self.stored()[0]['progressHistory'][-1]['status'],'completed')

    def test_nonwaiting_comment_is_retained_when_reply_is_completed(self):
        source=dict(id='active-complete',kind='comment',text='完了待ちの進捗記録',status='active',
                    createdAt='2026-01-01T01:00:00.000Z',subtaskIds=['s1'],subtaskTitles=['既存の調査'])
        self.seed([task(progressEnabled=True,progressStage='doing',progressHistory=[source])])
        self.progress();self.select_chat();self.reply(source['id'])
        self.page.get_by_label('完了',exact=True).check()
        self.send('進捗を完了にしました')
        result=self.stored()[0]
        self.assertEqual(len(result['progressHistory']),2)
        self.assertTrue(result['subtasks'][0]['completed'])
        self.assertEqual(result['progressHistory'][-1]['quote']['text'],source['text'])
        expect(self.entry(source['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))

    def test_plain_comment_is_gray_and_keeps_task_status(self):
        original=task(progressEnabled=True,progressStage='doing',waiting=True)
        self.seed([original]);self.progress();self.select_chat()
        self.page.get_by_label('ただのコメント',exact=True).check()
        expect(self.page.get_by_label('相手待ち',exact=True)).to_be_disabled()
        expect(self.page.get_by_label('小さいタスクの追加',exact=True)).to_be_disabled()
        self.send('進捗ではない補足')
        stored=self.stored()[0];note=stored['progressHistory'][0]
        self.assertTrue(note['plainComment'])
        self.assertTrue(stored['waiting'])
        self.assertEqual(stored['subtasks'],original['subtasks'])
        box=self.entry(note['id']).locator(':scope > div')
        expect(box).to_have_class(re.compile(r'\bbg-gray-50\b'))
        expect(box).to_have_class(re.compile(r'\bborder-gray-300\b'))
        self.page.reload();self.progress();self.select_chat()
        expect(box).to_have_class(re.compile(r'\bborder-gray-300\b'))
        dialog=self.open_report(start=TODAY.isoformat(),end=TODAY.isoformat())
        _,body=self.download_report(dialog)
        self.assertIn('進捗記録: 0件',body)
        self.assertIn('通常コメント: 1件',body)
        self.assertIn('記録の状態: 通常コメント（進捗ではない）',body)
        self.entry(note['id']).get_by_role('button',name='コメントを編集',exact=True).click()
        expect(self.page.get_by_label('ただのコメント',exact=True)).to_be_checked()

    def test_plain_reply_is_gray_without_resolving_waiting(self):
        source=dict(id='plain-source',kind='comment',createdAt='2026-01-01T01:00:00.000Z',text='相手からの回答待ち',status='waiting',subtaskIds=[],subtaskTitles=[])
        self.seed([task(progressEnabled=True,progressStage='doing',waiting=True,progressHistory=[source])])
        self.progress();self.select_chat();self.reply(source['id'])
        self.page.get_by_label('ただのコメント',exact=True).check()
        self.send('回答とは別の補足メモ')
        stored=self.stored()[0]
        self.assertTrue(stored['waiting'])
        self.assertEqual(len(stored['progressHistory']),2)
        note=stored['progressHistory'][-1]
        self.assertEqual(note['quote']['id'],source['id'])
        expect(self.entry(source['id'])).to_be_visible()
        box=self.entry(note['id']).locator(':scope > div')
        expect(box).to_have_class(re.compile(r'\bbg-gray-50\b'))
        expect(box).to_have_class(re.compile(r'\bborder-gray-300\b'))

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

    def test_waiting_reply_preserves_blue_source_and_roundtrips_purple(self):
        source=dict(id='waiting-source',kind='comment',createdAt='2026-01-01T01:00:00.000Z',
                    text='顧客からの回答を待っています',status='waiting',subtaskIds=[],subtaskTitles=[])
        self.seed([task(progressEnabled=True,progressStage='doing',waiting=True,progressHistory=[source])])
        self.progress();self.select_chat();self.reply(source['id'])
        expect(self.page.get_by_label('相手待ち',exact=True)).not_to_be_checked()
        self.send('回答を受領し再開しました')
        stored=self.stored()[0]
        self.assertEqual(len(stored['progressHistory']),2)
        self.assertFalse(stored['waiting'])
        message=stored['progressHistory'][-1]
        self.assertNotEqual(message['id'],source['id'])
        self.assertEqual(message['quote']['text'],source['text'])
        self.assertEqual(message['quote']['status'],'waiting')
        expect(self.entry(source['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))
        expect(self.entry(message['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-purple-50\b'))
        self.entry(message['id']).get_by_role('button',name='コメントを編集',exact=True).click()
        self.page.get_by_label('コメントの編集',exact=True).fill('受領した回答の補足を記録')
        self.page.get_by_role('button',name='編集を保存',exact=True).click()
        edited=self.stored()[0]['progressHistory'][-1]
        self.assertEqual(edited['quote'],message['quote'])
        self.assertEqual(edited['id'],message['id'])
        self.assertFalse(self.stored()[0]['waiting'])
        self.page.reload();self.progress();self.select_chat()
        expect(self.entry(message['id'])).to_contain_text(source['text'])
        expect(self.entry(message['id'])).to_contain_text('受領した回答の補足を記録')
        expect(self.entry(message['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-purple-50\b'))
        with self.page.expect_download() as download:
            self.page.get_by_role('button',name='エクスポート',exact=True).click()
        saved=json.loads(Path(download.value.path()).read_text())
        self.assertEqual(saved['tasks'][0]['progressHistory'],self.stored()[0]['progressHistory'])

    def test_reply_cancel_empty_and_composition_do_not_remove_source(self):
        source=dict(id='unanswered',kind='comment',createdAt='2026-01-01T01:00:00.000Z',
                    text='削除しない回答待ち',status='waiting',subtaskIds=[],subtaskTitles=[])
        self.seed([task(progressEnabled=True,progressStage='doing',waiting=True,progressHistory=[source])])
        self.progress();self.select_chat();self.reply(source['id'])
        expect(self.page.get_by_label('やるべきことの追加',exact=True)).to_be_enabled()
        expect(self.page.get_by_label('小さいタスクの追加',exact=True)).to_be_enabled()
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

    def test_nested_waiting_reply_is_purple_and_only_resolves_small_task(self):
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
        self.assertEqual(len(stored['progressHistory']),2)
        message=stored['progressHistory'][-1]
        self.assertEqual(message['smallTaskId'],'small1')
        self.assertEqual(message['subtaskIds'],['s1'])
        self.assertEqual(message['quote']['smallTaskTitle'],'資料の数字を確認')
        self.assertFalse(stored['subtasks'][0]['smallTasks'][0]['waiting'])
        self.assertTrue(stored['subtasks'][0]['waiting'])
        self.assertTrue(stored['waiting'])
        expect(self.entry(message['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-purple-50\b'))
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
        self.assertEqual(len(stored['progressHistory']),2)
        message=stored['progressHistory'][-1]
        self.assertNotEqual(message['id'],source['id'])
        self.assertEqual(message['smallTaskId'],'removed-small')
        self.assertEqual(message['quote']['id'],source['id'])
        self.assertEqual(message['subtaskIds'],['s1'])
        self.assertTrue(stored['subtasks'][0]['waiting'])
        self.assertTrue(stored['waiting'])
        expect(self.entry(message['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-purple-50\b'))

    def test_reply_to_deleted_todo_keeps_historical_parent_filter(self):
        source=dict(id='deleted-todo-wait',kind='comment',createdAt='2026-01-01T01:00:00.000Z',
                    text='削除されたやるべきことの回答待ち',status='waiting',subtaskIds=['removed-todo'],subtaskTitles=['以前の確認項目'])
        self.seed([task(progressEnabled=True,progressStage='doing',waiting=True,progressHistory=[source])])
        self.progress();self.select_chat();self.reply(source['id'])
        self.send('削除済みの確認項目への回答')
        stored=self.stored()[0]
        self.assertEqual(len(stored['progressHistory']),2)
        message=stored['progressHistory'][-1]
        self.assertEqual(message['subtaskIds'],['removed-todo'])
        self.assertEqual(message['subtaskTitles'],['以前の確認項目'])
        self.assertEqual(message['quote']['subtaskIds'],['removed-todo'])
        self.assertTrue(stored['waiting'])
        expect(self.entry(source['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))
        self.page.get_by_label('やるべきことで絞り込み',exact=True).select_option('removed-todo')
        expect(self.entry(message['id'])).to_be_visible()
        expect(self.entry(message['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-purple-50\b'))

    def test_replies_preserve_quote_chain_and_blue_waiting_sources(self):
        source=dict(id='chain-start',kind='comment',createdAt='2026-01-01T01:00:00.000Z',
                    text='最初の回答依頼',status='waiting',subtaskIds=[],subtaskTitles=[])
        self.seed([task(progressEnabled=True,progressStage='doing',waiting=True,progressHistory=[source])])
        self.progress();self.select_chat();self.reply(source['id'])
        self.page.get_by_label('相手待ち',exact=True).check()
        self.send('追加の回答を依頼しました')
        first=self.stored()[0]['progressHistory'][-1]
        expect(self.entry(first['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-green-50\b'))
        self.reply(first['id']);self.send('すべての回答を受領しました')
        history=self.stored()[0]['progressHistory']
        self.assertEqual(len(history),3)
        final=history[-1]
        self.assertEqual(final['quote']['id'],first['id'])
        self.assertEqual(final['quote']['quote']['id'],source['id'])
        self.assertEqual(final['quote']['quote']['text'],source['text'])
        expect(self.entry(final['id'])).to_contain_text(source['text'])
        expect(self.entry(final['id'])).to_contain_text('追加の回答を依頼しました')
        expect(self.entry(final['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-purple-50\b'))

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
        expect(box).to_have_text('')
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
        expect(row).to_be_visible()
        toggle=self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True)
        toggle.click();expect(toggle).not_to_have_attribute('aria-expanded','true')
        expect(row).to_be_visible()
        expect(row).to_have_class(re.compile(r'\bbg-purple-50\b'))
        expect(row).not_to_contain_text('期限')
        toggle.click();expect(row).to_be_visible()

    def test_waiting_small_task_addition_is_green_persists_and_replies_purple(self):
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
        expect(box).to_have_class(re.compile(r'\bbg-green-50\b'))
        self.page.get_by_label('やるべきことで絞り込み',exact=True).select_option('s1')
        expect(self.entry(message['id'])).to_be_visible()
        self.page.reload();self.progress();self.select_chat()
        expect(box).to_have_class(re.compile(r'\bbg-green-50\b'))
        with self.page.expect_download() as download:
            self.page.get_by_role('button',name='エクスポート',exact=True).click()
        backup=Path(download.value.path()).read_bytes()
        self.assertEqual(json.loads(backup)['tasks'][0]['progressHistory'],[message])
        self.seed([])
        self.page.get_by_label('バックアップをインポート',exact=True).set_input_files(dict(name='small-addition.json',mimeType='application/json',buffer=backup))
        self.progress();self.select_chat()
        expect(box).to_have_class(re.compile(r'\bbg-green-50\b'))
        self.reply(message['id']);self.send('確認への回答を受領しました')
        stored=self.stored()[0]
        self.assertEqual(len(stored['progressHistory']),2)
        reply=stored['progressHistory'][-1]
        self.assertFalse(reply['addedSmallTask'])
        self.assertEqual(reply['quote']['id'],message['id'])
        self.assertTrue(reply['quote']['addedSmallTask'])
        self.assertEqual(reply['quote']['text'],small['title'])
        self.assertEqual(reply['smallTaskId'],small['id'])
        self.assertFalse(stored['subtasks'][0]['smallTasks'][0]['waiting'])
        expect(self.entry(message['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))
        expect(self.entry(reply['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-purple-50\b'))

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
        expect(box).to_have_class(re.compile(r'\bbg-green-50\b'))
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
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
        row=self.page.locator('[data-progress-small-task-id="'+small['id']+'"]')
        expect(row).to_be_visible()
        self.entry(message['id']).get_by_role('button',name='コメントを削除',exact=True).click()
        expected=json.loads(json.dumps(before))
        expected['progressHistory']=[reply]
        expected['deletedSmallTaskOriginIds']=[small['id']]
        expected['deletedProgressSmallTaskIds']=[small['id']]
        expected['deletedProgressEntryIds']=[message['id']]
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
        original['subtasks'][1]['smallTasks']=[dict(id='other',title='別の項目',completed=False)]
        self.seed([original]);self.progress();self.select_chat()
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
        row=self.page.locator('[data-progress-small-task-id="remove"]')
        row.click();self.reply(comment['id'])
        self.page.get_by_label('進捗コメント',exact=True).fill('送信していない下書き')
        row.get_by_role('button',name='一覧から削除する項目を削除',exact=True).click()
        expected=json.loads(json.dumps(original))
        expected['deletedProgressSmallTaskIds']=['remove']
        expected['subtasks'][0]['smallTasks']=[original['subtasks'][0]['smallTasks'][1]]
        self.assertEqual(self.stored()[0],expected)
        expect(row).to_have_count(0)
        expect(self.page.locator('[data-progress-small-task-id="keep"]')).to_be_visible()
        expect(self.entry(comment['id'])).to_be_visible()
        expect(self.page.get_by_label('進捗コメント',exact=True)).to_have_text('送信していない下書き')
        expect(self.page.get_by_role('region',name='返信先',exact=True)).to_be_visible()
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
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
        row=self.page.locator('[data-progress-small-task-id="remove"]')
        row.dblclick();self.send('以前の項目への記録')
        self.page.get_by_label('やるべきことで絞り込み',exact=True).select_option('')
        self.reply(source['id'])
        editor=self.page.get_by_label('進捗コメント',exact=True)
        editor.fill('別件の返信を入力中')
        history=self.stored()[0]['progressHistory']
        row.get_by_role('button',name='以前に選択した項目を削除',exact=True).click()
        expect(row).to_have_count(0)
        expect(self.page.get_by_role('region',name='返信先',exact=True)).to_be_visible()
        expect(editor).to_have_text('別件の返信を入力中')
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
        expect(editor).to_have_text('編集中の返信も保持')
        expected=json.loads(json.dumps(original))
        expected['progressHistory']=[reply]
        expected['deletedProgressEntryIds']=[source['id']]
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
                expect(self.page.get_by_label('進捗コメント',exact=True)).to_have_text('')
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
        expect(self.entry(note['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-purple-50\b'))
        self.entry(note['id']).get_by_role('button',name='コメントを削除',exact=True).click()
        expected=json.loads(json.dumps(original));expected['progressHistory']=[]
        expected['deletedProgressEntryIds']=[note['id']]
        self.assertEqual(self.stored()[0],expected)
        expect(self.entry(note['id'])).to_have_count(0)

    def test_nested_small_task_card_comment_edit_and_status_scope(self):
        original=task(progressEnabled=True,progressStage='doing')
        original['subtasks'][0]['smallTasks']=[dict(id='small1',title='資料の目次を作成',completed=False,waiting=False)]
        self.seed([original]);self.progress();self.select_chat()
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
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
        self.reply(message['id'])
        self.page.get_by_label('完了',exact=True).check()
        self.send('目次作成を完了')
        stored=self.stored()[0]
        self.assertTrue(stored['subtasks'][0]['smallTasks'][0]['completed'])
        self.assertEqual(stored['progressHistory'][-1]['quote']['id'],message['id'])
        self.assertEqual(stored['progressHistory'][-1]['quote']['text'],edited['text'])
        self.assertFalse(stored['subtasks'][0]['completed'])
        self.assertFalse(stored['completed'])

    def test_nested_comments_keep_parent_only_filter_and_roundtrip(self):
        original=task(progressEnabled=True,progressStage='doing')
        original['subtasks'][0]['smallTasks']=[dict(id='small1',title='一覧に含めない小さい項目',completed=False)]
        self.seed([original]);self.progress();self.select_chat()
        expect(self.page.get_by_label('関連: 一覧に含めない小さい項目',exact=True)).to_have_count(0)
        select=self.page.get_by_label('やるべきことで絞り込み',exact=True)
        self.assertEqual(select.locator('option').all_text_contents(),['すべてのやるべきこと','既存の調査','期限切れの確認'])
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
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
        self.page.get_by_label('バックアップをインポート',exact=True).set_input_files(dict(name='nested-backup.json',mimeType='application/json',buffer=saved))
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

    def test_add_todo_records_a_purple_dated_origin(self):
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
        self.assertEqual(len(stored['progressHistory']),1)
        self.assertEqual(stored['progressHistory'][0]['text'],FUTURE+'までに【コメントから追加する資料作成】')
        self.assertTrue(stored['progressHistory'][0]['addedSubtask'])
        expect(self.page.locator('[data-progress-entry-id]')).to_have_count(1)
        expect(self.page.get_by_role('button',name='コメントを編集',exact=True)).to_have_count(1)
        self.page.get_by_role('button',name='ボード',exact=True).click()
        expect(self.page.locator('#task-'+new_subtask['id'])).to_contain_text('コメントから追加する資料作成')

    def test_legacy_todo_origin_is_formatted_without_rewriting_saved_history(self):
        history=[
            dict(id='legacy-own',kind='comment',createdAt='2026-01-01T01:00:00.000Z',
                 text='既存の調査',subtaskIds=['s1'],subtaskTitles=['既存の調査'],addedSubtask=True,status='active'),
            dict(id='legacy-reaction',kind='change',createdAt='2026-01-01T01:00:00.001Z',
                 text='やるべきこと「既存の調査」を追加しました',subtaskIds=['s1'],subtaskTitles=['既存の調査'])]
        self.seed([task(progressEnabled=True,progressStage='doing',progressHistory=history)])
        self.progress();self.select_chat()
        expect(self.entry('legacy-own')).to_contain_text(FUTURE+'までに【既存の調査】')
        expect(self.entry('legacy-reaction')).to_have_count(0)
        expect(self.page.get_by_role('button',name='コメントを編集',exact=True)).to_have_count(1)
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
            expect(self.entry(entry['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-purple-50\b'))
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
            dict(id='small-completed',kind='comment',text='小さい作業の完了',status='completed',smallTaskId='small1',smallTaskTitle='小さい項目',addedSmallTask=True),
            dict(id='small-reply',kind='comment',text='小さい作業への返信',status='active',smallTaskId='small1',smallTaskTitle='小さい項目',quote=dict(id='old-small',text='引用元の小さい項目',status='active')),
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
        self.page.get_by_role('button',name='小さい項目の完了済みトークを展開',exact=True).click()
        expected={'normal':'bg-purple-50','waiting':'bg-green-50','small':'bg-blue-50','small-waiting':'bg-blue-50','small-reply':'bg-blue-50','small-completed':'bg-blue-50','deadline':'bg-purple-50'}
        expect(self.page.locator('[data-progress-entry-id]')).to_have_count(len(expected))
        for key,color in expected.items():
            expect(self.entry(key).locator(':scope > div')).to_have_class(re.compile(r'\b'+color+r'\b'))
        for key in ['empty-reason','no-reason','rename','added','status']:
            expect(self.entry(key)).to_have_count(0)
        self.page.get_by_label('やるべきことで絞り込み',exact=True).select_option('s1')
        expect(self.page.locator('[data-progress-entry-id]')).to_have_count(len(expected))
        self.assertEqual(self.stored()[0]['progressHistory'],entries)
        self.page.reload();self.progress();self.select_chat()
        self.page.get_by_role('button',name='小さい項目の完了済みトークを展開',exact=True).click()
        expect(self.page.locator('[data-progress-entry-id]')).to_have_count(len(expected))
        self.assertEqual(self.stored()[0]['progressHistory'],entries)

    def test_comment_colors_follow_edited_status_and_small_task_scope(self):
        original=task(progressEnabled=True,progressStage='doing')
        original['subtasks'][0]['smallTasks']=[dict(id='small1',title='小さい項目',completed=False)]
        self.seed([original]);self.progress();self.select_chat();self.send('色を変更する進捗')
        message=self.stored()[0]['progressHistory'][0]
        box=self.entry(message['id']).locator(':scope > div')
        expect(box).to_have_class(re.compile(r'\bbg-purple-50\b'))
        self.entry(message['id']).get_by_role('button',name='コメントを編集',exact=True).click()
        self.page.get_by_label('相手待ち',exact=True).check()
        self.page.get_by_role('button',name='編集を保存',exact=True).click()
        expect(box).to_have_class(re.compile(r'\bbg-green-50\b'))
        self.entry(message['id']).get_by_role('button',name='コメントを編集',exact=True).click()
        self.page.get_by_label('相手待ち',exact=True).uncheck()
        self.page.get_by_role('button',name='編集を保存',exact=True).click()
        expect(box).to_have_class(re.compile(r'\bbg-purple-50\b'))
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
        self.page.locator('[data-progress-small-task-id="small1"]').click()
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
        expect(editor).to_have_text('最初の担当者への依頼')
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
        self.assertEqual(len(stored['progressHistory']),1)
        self.assertTrue(stored['progressHistory'][0]['addedSubtask'])
        self.assertEqual(stored['progressHistory'][0]['text'],LATER+'までに【編集から追加した小タスク】')

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
        self.assertEqual(len(data['progressHistory']),1)
        origin=data['progressHistory'][0]
        self.assertTrue(origin['addedSubtask'])
        self.assertEqual(origin['text'],FUTURE+'までに【Enterで追加した調整】')
        expect(self.entry(origin['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-purple-50\b'))
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
        self.assertIn('bg-purple-50', self.card().get_attribute('class'))
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
