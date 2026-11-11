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

    def progress(self, home=False):
        self.page.get_by_role('button',name='進捗',exact=True).click()
        # Existing detail workflows now begin by opening a task from Home.
        tiles=self.page.get_by_label('大タスクのタイル',exact=True)
        if not home and tiles.get_by_role('button').count():tiles.get_by_role('button').first.click()

    def card(self,id='track'):
        return self.page.locator('[data-progress-task-id="'+id+'"]')

    def expand_talks(self):
        # Read all messages using the same expansion controls as the user.
        log=self.page.get_by_role('log',name='進捗履歴')
        for _ in range(50):
            buttons=log.get_by_role('button',name=re.compile(r'の(?:完了済み)?トークを展開$'))
            if not buttons.count():return
            buttons.first.click()
        self.fail('トークの展開が終了しませんでした')

    def select_chat(self,expand_threads=True):
        self.card().get_by_role('button',name='進捗テスト案件',exact=True).click()
        if expand_threads:self.expand_talks()

    def send(self,text,expand_threads=True):
        box=self.page.get_by_label('進捗コメント',exact=True)
        box.fill(text);box.press('Control+Enter')
        expect(box).to_have_text('')
        if expand_threads:self.expand_talks()

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
        dialog.get_by_label('レポート出力形式',exact=True).select_option('txt')
        with self.page.expect_download() as download:
            dialog.get_by_role('button',name='テキストをダウンロード',exact=True).click()
        raw=Path(download.value.path()).read_bytes()
        self.assertTrue(raw.startswith(b'\xef\xbb\xbf'))
        return download.value.suggested_filename,raw.decode('utf-8-sig')

    def connect_backup_file(self):
        # The picker is replaced because headless Chromium cannot operate the
        # OS dialog. The returned handle is real: writes, close, reads and IDB
        # structured-clone persistence all use Chromium's file implementation.
        self.page.evaluate('''async () => {
          const directory = await navigator.storage.getDirectory();
          window.backupFile = await directory.getFileHandle('taskmatrix-test.json', {create:true});
          window.backupControl = {permission:'granted',requests:0,writes:0,closed:0,fail:false,cancel:false,holdNext:false};
          window.showSaveFilePicker = async () => {
            if (backupControl.cancel) throw new DOMException('Cancelled','AbortError');
            return backupFile;
          };
          const proto = FileSystemFileHandle.prototype;
          proto.queryPermission = async () => backupControl.permission;
          proto.requestPermission = async () => {backupControl.requests++;return backupControl.permission;};
          const create = proto.createWritable;
          proto.createWritable = async function() {
            if (backupControl.fail) throw new DOMException('Disk full','QuotaExceededError');
            const stream = await create.call(this);
            return {
              write:async text => {
                backupControl.writes++;
                if (backupControl.holdNext) {
                  backupControl.holdNext=false;
                  await new Promise(resolve=>window.releaseBackupWrite=resolve);
                }
                return stream.write(text);
              },
              close:async()=>{await stream.close();backupControl.closed++;},
              abort:()=>stream.abort()
            };
          };
        }''')
        self.page.locator('[data-file-backup] summary').click()
        self.page.get_by_role('button',name='保存先ファイルを選択',exact=True).click()
        expect(self.page.get_by_label('ファイル保存状態',exact=True)).to_have_text('保存済み')

    def backup_contents(self):
        return self.page.evaluate('''async()=>JSON.parse(await(await(await navigator.storage.getDirectory()).getFileHandle('taskmatrix-test.json')).getFile().then(file=>file.text()))''')

    def test_file_backup_writes_all_data_auto_saves_and_restores_real_handle(self):
        original=task(progressEnabled=True,progressStage='doing')
        original['progressHistory']=[dict(id='image-link',kind='comment',status='active',text='https://example.com',subtaskIds=[],images=[dict(id='img',name='資料.png',src='data:image/png;base64,'+__import__('base64').b64encode(self.progress_png()).decode())],links=[dict(url='https://example.com',label='資料')])]
        self.seed([original])
        shared=dict(projects=[dict(id='p1',title='保存対象プロジェクト',type='project',durationWeeks=4,tasksTemplate=[])],recurringSchedules=[dict(id='r1',title='定例会議',frequency='weekly',interval=1,dayOfWeek=1,dayOfMonth=1,startDate=TODAY.isoformat(),endDate='',memo='',urls=[])],recurringCompletions={'r1_'+TODAY.isoformat():dict(completed=True,completionNote='保存対象の記録')})
        self.page.get_by_label('バックアップをインポート',exact=True).set_input_files(dict(name='shared.json',mimeType='application/json',buffer=json.dumps(shared,ensure_ascii=False).encode()))
        expect(self.page.get_by_text('データをインポートしました',exact=True)).to_be_visible()
        self.connect_backup_file()
        saved=self.backup_contents()
        self.assertEqual(set(saved),{'tasks','projects','recurringSchedules','recurringCompletions'})
        self.assertEqual(saved['tasks'],self.stored())
        for key,value in shared.items():self.assertEqual(saved[key],value)
        with self.page.expect_download() as download:self.page.get_by_role('button',name='エクスポート',exact=True).click()
        self.assertEqual(saved,json.loads(Path(download.value.path()).read_text()))
        self.progress();self.select_chat();self.send('ファイルへ自動保存する進捗')
        self.page.wait_for_function('backupControl.closed===2')
        self.assertEqual(self.backup_contents()['tasks'],self.stored())
        self.page.wait_for_function('''async()=>{const db=await new Promise(r=>{const q=indexedDB.open('TaskMatrixAppDB',1);q.onsuccess=()=>r(q.result)});return await new Promise(r=>{const q=db.transaction('appData').objectStore('appData').get('fileBackupSettings');q.onsuccess=()=>{db.close();r(!!q.result?.lastSavedAt)}})}''')
        self.page.reload();expect(self.page.get_by_role('heading',name='TaskMatrix Pro')).to_be_visible()
        expect(self.page.get_by_label('ファイル保存状態',exact=True)).to_have_text('接続済み')
        self.page.locator('[data-file-backup] summary').click()
        expect(self.page.get_by_text('保存先：taskmatrix-test.json',exact=True)).to_be_visible()
        self.progress();self.select_chat();self.send('再読み込み後も同じファイルへ保存')
        expect(self.page.get_by_label('ファイル保存状態',exact=True)).to_have_text('保存済み')
        self.assertEqual(self.backup_contents()['tasks'],self.stored())
        # A backup remains usable even after browser data is lost/replaced.
        raw=json.dumps(self.backup_contents(),ensure_ascii=False).encode()
        self.seed([])
        self.page.get_by_label('バックアップをインポート',exact=True).set_input_files(dict(name='file-backup.json',mimeType='application/json',buffer=raw))
        expect(self.page.get_by_text('データをインポートしました',exact=True)).to_be_visible()
        self.assertEqual(self.stored(),json.loads(raw)['tasks'])

    def test_file_backup_manual_mode_cancel_and_disconnect_preserve_file(self):
        self.seed([task(progressEnabled=True,progressStage='doing')]);self.connect_backup_file()
        before=self.backup_contents()
        self.page.get_by_label('変更時に自動で上書き保存',exact=True).uncheck()
        self.page.evaluate('backupControl.cancel=true')
        self.page.get_by_role('button',name='保存先を変更',exact=True).click()
        expect(self.page.get_by_label('ファイル保存状態',exact=True)).to_have_text('保存済み')
        self.progress();self.select_chat();self.send('手動で保存する進捗')
        expect(self.page.get_by_label('ファイル保存状態',exact=True)).to_have_text('未保存')
        self.page.wait_for_timeout(1200)
        self.assertEqual(self.backup_contents(),before)
        self.page.get_by_role('button',name='今すぐ保存',exact=True).click()
        expect(self.page.get_by_label('ファイル保存状態',exact=True)).to_have_text('保存済み')
        saved=self.backup_contents();self.assertEqual(saved['tasks'],self.stored())
        self.page.reload();expect(self.page.get_by_role('heading',name='TaskMatrix Pro')).to_be_visible()
        self.page.locator('[data-file-backup] summary').click()
        expect(self.page.get_by_label('変更時に自動で上書き保存',exact=True)).not_to_be_checked()
        self.page.get_by_role('button',name='保存先の接続を解除',exact=True).click()
        expect(self.page.get_by_role('button',name='今すぐ保存',exact=True)).to_be_disabled()
        self.assertEqual(self.backup_contents(),saved)

    def test_file_backup_permission_and_write_failures_are_visible_and_retryable(self):
        self.seed([task(progressEnabled=True,progressStage='doing')]);self.connect_backup_file()
        before=self.backup_contents();self.page.evaluate("backupControl.permission='prompt'")
        self.progress();self.select_chat();self.send('権限を失った後の進捗')
        expect(self.page.get_by_label('ファイル保存状態',exact=True)).to_have_text('許可が必要')
        self.assertEqual(self.page.evaluate('backupControl.requests'),0)
        self.assertEqual(self.backup_contents(),before)
        self.page.get_by_role('button',name='今すぐ保存',exact=True).click()
        expect(self.page.get_by_role('alert').filter(has_text='書き込みの許可が必要')).to_be_visible()
        self.assertEqual(self.page.evaluate('backupControl.requests'),1)
        self.page.evaluate("backupControl.permission='granted';backupControl.fail=true")
        self.page.get_by_role('button',name='今すぐ保存',exact=True).click()
        expect(self.page.get_by_label('ファイル保存状態',exact=True)).to_have_text('保存失敗')
        expect(self.page.get_by_role('alert').filter(has_text='ファイルへの保存に失敗')).to_be_visible()
        self.assertEqual(self.backup_contents(),before)
        self.page.evaluate('backupControl.fail=false')
        self.page.get_by_role('button',name='今すぐ保存',exact=True).click()
        expect(self.page.get_by_label('ファイル保存状態',exact=True)).to_have_text('保存済み')
        self.assertEqual(self.backup_contents()['tasks'],self.stored())

    def test_file_backup_serializes_changes_during_an_in_flight_write(self):
        self.seed([task(progressEnabled=True,progressStage='doing')]);self.connect_backup_file()
        self.progress();self.select_chat();self.page.evaluate('backupControl.holdNext=true')
        self.send('保存途中の最初の進捗');self.page.wait_for_function('!!window.releaseBackupWrite')
        expect(self.page.get_by_label('ファイル保存状態',exact=True)).to_have_text('保存中…')
        self.send('保存中に追加した最新の進捗')
        self.page.evaluate('releaseBackupWrite()')
        self.page.wait_for_function('backupControl.closed===3')
        expect(self.page.get_by_label('ファイル保存状態',exact=True)).to_have_text('保存済み')
        self.assertEqual(self.backup_contents()['tasks'],self.stored())

    def test_file_backup_unsupported_browser_keeps_export_available(self):
        self.page.add_init_script('window.showSaveFilePicker=undefined')
        self.page.reload();expect(self.page.get_by_role('heading',name='TaskMatrix Pro')).to_be_visible()
        self.page.locator('[data-file-backup] summary').click()
        expect(self.page.get_by_text(re.compile('このブラウザーでは直接上書き保存に対応していません'))).to_be_visible()
        expect(self.page.get_by_role('button',name='保存先ファイルを選択',exact=True)).to_have_count(0)
        with self.page.expect_download() as download:self.page.get_by_role('button',name='エクスポート',exact=True).click()
        self.assertIn('tasks',json.loads(Path(download.value.path()).read_text()))

    def test_file_backup_auto_save_preference_survives_without_a_connected_file(self):
        self.page.locator('[data-file-backup] summary').click()
        self.page.get_by_label('変更時に自動で上書き保存',exact=True).uncheck()
        self.page.wait_for_function('''async()=>{const db=await new Promise(r=>{const q=indexedDB.open('TaskMatrixAppDB',1);q.onsuccess=()=>r(q.result)});return await new Promise(r=>{const q=db.transaction('appData').objectStore('appData').get('fileBackupSettings');q.onsuccess=()=>{db.close();r(q.result?.enabled===false)}})}''')
        self.page.reload();expect(self.page.get_by_role('heading',name='TaskMatrix Pro')).to_be_visible()
        self.page.locator('[data-file-backup] summary').click()
        expect(self.page.get_by_label('変更時に自動で上書き保存',exact=True)).not_to_be_checked()
        expect(self.page.get_by_role('button',name='今すぐ保存',exact=True)).to_be_disabled()

    def test_talk_opens_at_latest_in_each_scope_and_jump_buttons_follow_resizes(self):
        original=task(progressEnabled=True,progressStage='doing')
        original['subtasks'][0]['smallTasks']=[dict(id='a',title='長い小作業')]
        original['progressHistory']=[]
        for scope in ['root','todo','small']:
            for index in range(18):
                original['progressHistory'].append(dict(id=f'{scope}-{index}',kind='comment',status='active',text=f'{scope}の記録{index}\n'+('途中の経緯\n'*4),subtaskIds=[] if scope=='root' else ['s1'],**(dict(smallTaskId='a',smallTaskTitle='長い小作業') if scope=='small' else {})))
        self.seed([original]);self.progress()
        log=self.page.get_by_role('log',name='進捗履歴',exact=True)
        bottom='''()=>{const el=document.querySelector('[role="log"]');return !!el&&el.scrollHeight-el.clientHeight-el.scrollTop<3}'''
        for scope in ['root','todo','small']:
            if scope=='root':self.card().get_by_role('button',name='進捗テスト案件',exact=True).click()
            else:self.page.get_by_role('button',name=('既存の調査' if scope=='todo' else '長い小作業')+'のトークを表示',exact=True).click()
            self.page.wait_for_function(bottom)
            self.assertGreater(log.evaluate('el=>el.scrollHeight-el.clientHeight'),500)
            self.page.get_by_role('button',name='トークの一番上へ',exact=True).click()
            self.assertEqual(log.evaluate('el=>el.scrollTop'),0)
            self.page.get_by_role('button',name='トークの一番下へ',exact=True).click();self.page.wait_for_function(bottom)
        # Images/expanded content may increase the height after initial layout.
        log.locator('[data-progress-body]').last.evaluate("el=>{el.style.display='block';el.style.paddingBottom='400px'}")
        self.page.wait_for_function(bottom)
        self.page.get_by_role('button',name='トークの一番上へ',exact=True).click()
        log.locator('[data-progress-body]').last.evaluate("el=>el.style.paddingBottom='800px'")
        self.page.wait_for_timeout(150);self.assertEqual(log.evaluate('el=>el.scrollTop'),0)
        self.send('送信後は最新の末尾へ',expand_threads=False);self.page.wait_for_function(bottom)

    def test_talk_body_quotes_conclusions_links_and_editor_text_are_black(self):
        original=task(progressEnabled=True,progressStage='doing')
        wait=dict(id='wait',kind='comment',status='waiting',text='相手待ちの本文 https://example.com/request',subtaskIds=[])
        original['progressHistory']=[wait,dict(id='progress',kind='comment',status='active',text='進捗の本文',quote=dict(wait,status='active'),subtaskIds=[]),dict(id='note',kind='comment',status='note',plainComment=True,text='普通のコメントの本文',subtaskIds=[]),dict(id='result',kind='comment',status='active',text='結論の本文',subtaskIds=['s1'],isConclusion=True,links=[dict(id='link',url='https://example.com/result',label='添付リンク')])]
        self.seed([original]);self.progress();self.select_chat()
        log=self.page.get_by_role('log',name='進捗履歴',exact=True)
        colors=log.locator('[data-progress-body], a').evaluate_all('(els)=>els.map(el=>getComputedStyle(el).color)')
        self.assertGreater(len(colors),5);self.assertEqual(set(colors),{'rgb(0, 0, 0)'})
        self.assertNotEqual(self.entry('wait').get_by_text('相手待ち',exact=True).evaluate('el=>getComputedStyle(el).color'),'rgb(0, 0, 0)')
        self.entry('progress').get_by_role('button',name='コメントを編集',exact=True).click()
        self.assertEqual(self.page.get_by_label('コメントの編集',exact=True).evaluate('el=>getComputedStyle(el).color'),'rgb(0, 0, 0)')

    def reply_edit_task(self,other_reply=False):
        original=task(progressEnabled=True,progressStage='doing')
        original['subtasks'][0]['smallTasks']=[dict(id='a',title='返信を移す作業')]
        first=dict(id='w1',kind='comment',status='waiting',text='以前の相手待ち',createdAt='2026-11-01T01:00:00Z',subtaskIds=['s1'],smallTaskId='a',smallTaskTitle='返信を移す作業',resolvedByReplyId='reply')
        second=dict(id='w2',kind='comment',status='waiting',text='変更先の相手待ち',createdAt='2026-11-01T02:00:00Z',subtaskIds=['s2'])
        reply=dict(id='reply',kind='comment',status='active',text='保存してある返信',createdAt='2026-11-01T03:00:00Z',subtaskIds=['s1'],smallTaskId='a',smallTaskTitle='返信を移す作業',quote=first)
        original['progressHistory']=[first,second,reply,dict(id='later',kind='comment',status='note',plainComment=True,text='変更前の返信を引用したメモ',subtaskIds=['s1'],smallTaskId='a',quote=reply)]
        original['deletedProgressEntryIds']=['deleted-reply']
        original['progressHistory'].append(dict(id='archived',kind='comment',status='note',plainComment=True,text='削除済みの返信を引用したメモ',subtaskIds=['s1'],smallTaskId='a',quote=dict(reply,id='deleted-reply')))
        if other_reply:original['progressHistory'].append(dict(reply,id='other-reply',text='別の有効な回答'))
        return original

    def test_edit_reply_reassigns_wait_and_clears_reply_without_stale_quotes_reclosing(self):
        original=self.reply_edit_task();self.seed([original]);self.progress()
        self.page.get_by_role('button',name='返信を移す作業のトークを表示',exact=True).click()
        self.entry('reply').get_by_role('button',name='コメントを編集',exact=True).click()
        before=self.stored()
        self.page.get_by_role('button',name='返信元を変更',exact=True).click()
        expect(self.page.get_by_label('返信元に選択: 保存してある返信',exact=True)).to_be_disabled()
        expect(self.page.get_by_label('返信元に選択: 変更前の返信を引用したメモ',exact=True)).to_be_disabled()
        self.page.get_by_label('返信元に選択: 変更先の相手待ち',exact=True).check()
        self.assertEqual(self.stored(),before)
        expect(self.page.get_by_role('region',name='返信先',exact=True)).to_contain_text('変更先の相手待ち')
        self.page.get_by_role('button',name='編集を保存',exact=True).click()
        saved=self.stored()[0];by_id={entry['id']:entry for entry in saved['progressHistory']}
        self.assertNotIn('resolvedByReplyId',by_id['w1']);self.assertEqual(by_id['w2']['resolvedByReplyId'],'reply')
        self.assertTrue(saved['subtasks'][0]['smallTasks'][0]['waiting']);self.assertFalse(saved['subtasks'][1]['waiting'])
        self.assertEqual(by_id['reply']['quote']['id'],'w2');self.assertEqual(by_id['reply']['subtaskIds'],['s2'])
        self.assertEqual(by_id['reply']['createdAt'],original['progressHistory'][2]['createdAt'])
        self.assertEqual(by_id['later']['quote']['quote']['text'],'以前の相手待ち')
        self.page.reload();self.progress();self.assertTrue(self.stored()[0]['subtasks'][0]['smallTasks'][0]['waiting'])
        self.page.get_by_role('button',name='期限切れの確認のトークを表示',exact=True).click()
        self.entry('reply').get_by_role('button',name='コメントを編集',exact=True).click()
        self.page.get_by_role('button',name='返信を解除',exact=True).click()
        expect(self.page.get_by_role('region',name='返信先',exact=True)).to_have_count(0)
        self.page.get_by_role('button',name='編集を保存',exact=True).click()
        saved=self.stored()[0];self.assertTrue(saved['subtasks'][1]['waiting'])
        self.assertIsNone(next(entry for entry in saved['progressHistory'] if entry['id']=='reply')['quote'])
        self.page.reload();self.assertTrue(self.stored()[0]['subtasks'][1]['waiting'])

    def test_reply_source_edit_cancel_and_other_waiting_replies_remain_valid(self):
        original=self.reply_edit_task(other_reply=True);self.seed([original]);self.progress();self.select_chat()
        self.entry('reply').get_by_role('button',name='コメントを編集',exact=True).click()
        before=self.stored()
        self.page.get_by_role('button',name='返信元を変更',exact=True).click()
        self.page.get_by_label('返信元に選択: 変更先の相手待ち',exact=True).check()
        self.page.get_by_role('button',name='編集をキャンセル',exact=True).click();self.assertEqual(self.stored(),before)
        self.entry('reply').get_by_role('button',name='コメントを編集',exact=True).click()
        self.page.get_by_role('button',name='返信元を変更',exact=True).click()
        self.page.get_by_label('返信元に選択: 変更先の相手待ち',exact=True).check()
        self.page.get_by_role('button',name='選択を終了',exact=True).click()
        self.page.get_by_role('button',name='編集を保存',exact=True).click()
        saved=self.stored()[0];first=next(entry for entry in saved['progressHistory'] if entry['id']=='w1')
        self.assertEqual(first['resolvedByReplyId'],'other-reply');self.assertFalse(saved['subtasks'][0]['smallTasks'][0].get('waiting',False))
        self.page.reload();self.assertEqual(next(entry for entry in self.stored()[0]['progressHistory'] if entry['id']=='w1')['resolvedByReplyId'],'other-reply')

    def test_waiting_popup_shows_every_pending_message_in_each_scope(self):
        original=task(progressEnabled=True,progressStage='doing')
        original['subtasks'][0]['smallTasks']=[dict(id='a',title='複数回答待ちの作業')]
        original['progressHistory']=[]
        for scope in ['root','todo','small']:
            for index in range(2):
                original['progressHistory'].append(dict(id=f'{scope}-{index}',kind='comment',status='waiting',text=f'{scope}の確認依頼{index}',subtaskIds=[] if scope=='root' else ['s1'],**(dict(smallTaskId='a',smallTaskTitle='複数回答待ちの作業') if scope=='small' else {})))
        self.seed([original]);self.progress()
        dialog=self.page.get_by_role('dialog',name='相手待ちステータス一覧',exact=True)
        for title,count in [('進捗テスト案件',6),('既存の調査',4),('複数回答待ちの作業',2)]:
            self.page.get_by_role('button',name=title+'の相手待ち一覧',exact=True).click()
            expect(dialog.locator('[data-waiting-status-key]')).to_have_count(count)
            expect(dialog).to_contain_text('smallの確認依頼0');expect(dialog).to_contain_text('smallの確認依頼1')
            dialog.get_by_role('button',name='閉じる',exact=True).click()
        self.page.get_by_role('button',name='複数回答待ちの作業のトークを表示',exact=True).click()
        self.reply('small-0');self.send('最初の確認だけ回答済み',expand_threads=False)
        self.page.get_by_role('button',name='複数回答待ちの作業の相手待ち一覧',exact=True).click()
        expect(dialog.locator('[data-waiting-status-key]')).to_have_count(1)
        expect(dialog).not_to_contain_text('smallの確認依頼0');expect(dialog).to_contain_text('smallの確認依頼1')
        dialog.get_by_role('button',name='閉じる',exact=True).click();self.page.reload();self.progress()
        self.page.get_by_role('button',name='進捗テスト案件の相手待ち一覧',exact=True).click();expect(dialog.locator('[data-waiting-status-key]')).to_have_count(5)

    def test_reply_edit_can_add_quote_and_preserves_existing_creation_cards(self):
        for kind in ['comment','todo','small']:
            with self.subTest(kind=kind):
                original=task(progressEnabled=True,progressStage='doing')
                waiting=dict(id='wait',kind='comment',status='waiting',text='返信先にする依頼',subtaskIds=['s2'])
                entry=dict(id='entry',kind='comment',status='active',text='追加済みの記録',subtaskIds=['s1'])
                if kind=='todo':
                    original['subtasks'].append(dict(id='created',title='追加済みの記録',dueDate=FUTURE,completed=False))
                    entry.update(addedSubtask=True,subtaskIds=['created'],subtaskTitles=['追加済みの記録'],text=FUTURE+'までに【追加済みの記録】')
                if kind=='small':
                    original['subtasks'][0]['smallTasks']=[dict(id='created',title='追加済みの記録')]
                    entry.update(addedSmallTask=True,smallTaskId='created',smallTaskTitle='追加済みの記録')
                original['progressHistory']=[waiting,entry]
                self.seed([original]);self.progress();self.select_chat()
                self.entry('entry').get_by_role('button',name='コメントを編集',exact=True).click()
                self.page.get_by_role('button',name='返信元を変更',exact=True).click()
                self.page.get_by_label('返信元に選択: 返信先にする依頼',exact=True).check()
                self.page.get_by_role('button',name='編集を保存',exact=True).click()
                saved=self.stored()[0];edited=next(item for item in saved['progressHistory'] if item['id']=='entry')
                self.assertEqual(edited['quote']['id'],'wait');self.assertEqual(len(saved['subtasks']),len(original['subtasks']))
                self.assertEqual(len(saved['progressHistory']),2)
                if kind=='comment':self.assertEqual(edited['subtaskIds'],['s2'])
                elif kind=='todo':self.assertEqual(edited['subtaskIds'],['created']);self.assertTrue(edited['addedSubtask'])
                else:
                    self.assertEqual(edited['smallTaskId'],'created');self.assertTrue(edited['addedSmallTask'])
                    self.assertEqual(len(saved['subtasks'][0]['smallTasks']),1)

    def test_root_completion_button_appears_after_all_todos_and_reopens_with_child(self):
        original=task(progressEnabled=True,progressStage='doing')
        original['subtasks'][0]['smallTasks']=[dict(id='small',title='最後の小作業',completed=False)]
        original['subtasks'][1]['completed']=True
        original['progressHistory']=[dict(id='progress',kind='comment',text='保存しておく進捗',status='active',subtaskIds=['s1'],subtaskTitles=['既存の調査'],smallTaskId='small',smallTaskTitle='最後の小作業')]
        self.seed([original]);self.progress()
        complete=self.card().get_by_role('button',name='進捗テスト案件を完了',exact=True)
        expect(complete).to_have_count(0)
        self.page.get_by_role('button',name='最後の小作業のトークを表示',exact=True).click()
        self.page.get_by_role('button',name='最後の小作業を完了',exact=True).click()
        expect(complete).to_have_count(0)
        self.page.get_by_role('button',name='既存の調査を完了',exact=True).click()
        expect(complete).to_be_visible()
        history=self.stored()[0]['progressHistory'];before=self.page.evaluate('Date.now()')
        complete.click()
        after=self.stored()[0];self.assertTrue(after['completed']);self.assertFalse(after['waiting'])
        self.assertEqual(after['completionSource'],'manual');self.assertEqual(after['progressHistory'],history)
        self.assertGreaterEqual(self.page.evaluate('value=>Date.parse(value)',after['completedAt']),before)
        expect(self.card()).to_have_count(0);expect(complete).to_have_count(0)
        expect(self.page.get_by_label('トークのタイトル',exact=True)).to_have_text('最後の小作業')
        self.page.reload();self.progress();self.assertTrue(self.stored()[0]['completed'])
        expect(self.card()).to_have_count(0)
        self.page.get_by_role('button',name='完了済みタスクを表示',exact=True).click()
        expect(self.card()).to_have_class(re.compile(r'\bbg-blue-50\b'))
        self.page.get_by_role('button',name='最後の小作業のトークを表示',exact=True).click()
        self.page.get_by_role('button',name='最後の小作業の完了を取り消す',exact=True).click()
        after=self.stored()[0];self.assertFalse(after['completed']);self.assertNotIn('completedAt',after)
        expect(self.card()).to_have_count(0)
        self.page.get_by_role('button',name='未完了タスクを表示',exact=True).click()
        expect(self.card()).to_be_visible()
        expect(complete).to_have_count(0)
        self.page.get_by_role('button',name='最後の小作業を完了',exact=True).click()
        self.page.get_by_role('button',name='既存の調査を完了',exact=True).click()
        expect(complete).to_be_visible()

    def test_root_completion_stays_hidden_for_waits_and_appears_after_explicit_reply(self):
        original=task(progressEnabled=True,progressStage='doing',waiting=True)
        for st in original['subtasks']:st['completed']=True
        original['progressHistory']=[dict(id='waiting',kind='comment',text='案件全体への承認待ち',status='waiting',subtaskIds=[])]
        self.seed([original]);self.progress();self.select_chat()
        complete=self.card().get_by_role('button',name='進捗テスト案件を完了',exact=True)
        expect(complete).to_have_count(0)
        self.send('承認とは関係しない進捗');expect(complete).to_have_count(0)
        self.reply('waiting');self.send('承認の返信を受領');expect(complete).to_be_visible()
        complete.click();self.assertTrue(self.stored()[0]['completed'])
        for blocked in ['root','todo','waiting']:
            with self.subTest(blocked=blocked):
                original=task(progressEnabled=True,progressStage='doing')
                for st in original['subtasks']:st['completed']=True
                if blocked=='root':original['dependencies']=[dict(kind='subtask',id='missing',title='未完了の関連先')]
                else:
                    original['subtasks'][0]['completed']=False
                    if blocked=='todo':original['subtasks'][0]['dependencies']=[dict(kind='subtask',id='missing',title='未完了の関連先')]
                    else:original['subtasks'][0]['waiting']=True
                self.seed([original]);self.progress();expect(complete).to_have_count(0)
        original=task(progressEnabled=True,progressStage='doing');original['subtasks']=[];self.seed([original])
        self.progress();expect(complete).to_be_visible();complete.click();self.assertTrue(self.stored()[0]['completed'])

    def test_root_completion_visibility_follows_todo_completion_edits(self):
        original=task(progressEnabled=True,progressStage='doing')
        for st in original['subtasks']:st['completed']=True
        self.seed([original]);self.progress()
        complete=self.card().get_by_role('button',name='進捗テスト案件を完了',exact=True)
        expect(complete).to_be_visible()
        self.card().get_by_role('button',name='進捗テスト案件の設定',exact=True).click()
        dialog=self.page.get_by_role('dialog',name='進捗の設定',exact=True)
        dialog.get_by_role('checkbox',name='完了',exact=True).first.uncheck()
        dialog.get_by_role('button',name='確定',exact=True).click();expect(complete).to_have_count(0)
        self.page.get_by_role('button',name='既存の調査を完了',exact=True).click();expect(complete).to_be_visible()
        complete.click();self.assertTrue(self.stored()[0]['completed'])
        expect(self.card()).to_have_count(0)
        self.page.get_by_role('button',name='完了済みタスクを表示',exact=True).click()
        self.card().get_by_role('button',name='進捗テスト案件の設定',exact=True).click()
        dialog.get_by_role('checkbox',name='完了',exact=True).first.uncheck()
        dialog.get_by_role('button',name='確定',exact=True).click()
        self.assertFalse(self.stored()[0]['completed']);self.assertNotIn('completedAt',self.stored()[0])
        expect(self.card()).to_have_count(0)
        self.page.get_by_role('button',name='未完了タスクを表示',exact=True).click()
        expect(self.card()).to_have_class(re.compile(r'\bbg-purple-50\b'));expect(complete).to_have_count(0)
        self.page.reload();self.assertFalse(self.stored()[0]['completed'])

    def test_completed_board_switch_search_and_completion_month_use_actual_local_dates(self):
        live=task(progressEnabled=True,progressStage='doing')
        live['subtasks'][0]['smallTasks']=[dict(id='blue',title='完了して残す小作業',completed=True,completionManaged=True,completionSource='manual')]
        recent=task('recent',progressEnabled=True,progressStage='doing');recent.update(title='完了した設計',completed=True,completedAt='2026-11-05T03:00:00Z')
        recent['progressHistory']=[dict(id='secret',kind='comment',text='Moons検証資料',status='active',subtaskIds=[],links=[dict(id='l',label='評価資料',url='https://example.com/spec')])]
        earlier=task('earlier',progressEnabled=True,progressStage='todo');earlier.update(title='完了した試験',completed=True,completedAt='2025-01-31T15:30:00Z')
        earlier['subtasks'][0]['title']='資料の比較'
        unknown=task('unknown',progressEnabled=True,progressStage='doing');unknown.update(title='完了日時が未記録の旧タスク',completed=True,dueDate='2026-11-20')
        self.seed([live,recent,earlier,unknown]);self.progress()
        board=self.page.get_by_role('region',name='着手中ボード',exact=True)
        expect(self.card()).to_be_visible();expect(self.card('recent')).to_have_count(0);expect(self.card('earlier')).to_have_count(0)
        expect(self.page.locator('[data-progress-small-task-id="blue"]')).to_have_class(re.compile(r'\bbg-blue-50\b'))
        expect(board.get_by_role('button',name='完了時期で絞り込み',exact=True)).to_be_disabled()
        board.get_by_role('button',name='完了済みタスクを表示',exact=True).click()
        self.assertEqual(board.locator('[data-progress-task-id]').evaluate_all('(els)=>els.map(el=>el.dataset.progressTaskId)'),['recent','earlier','unknown'])
        expect(self.card('unknown').get_by_text('完了日時: 未記録',exact=True)).to_be_visible()
        board.get_by_role('button',name='完了時期で絞り込み',exact=True).click()
        month=board.get_by_label('完了した年月',exact=True);month.fill('2026-11')
        expect(self.card('recent')).to_be_visible();expect(self.card('unknown')).to_have_count(0);expect(self.card('earlier')).to_have_count(0)
        search=board.get_by_label('ボードのタスクを検索',exact=True)
        search.fill('mOoNs');expect(self.card('recent')).to_be_visible()
        search.fill('存在しない検索語');expect(board.get_by_text('条件に一致するタスクはありません。',exact=True)).to_be_visible()
        search.fill('');month.fill('2025-02')
        expect(self.card('earlier')).to_be_visible();expect(self.card('recent')).to_have_count(0)
        board.get_by_role('button',name='年月指定を解除',exact=True).click()
        search.fill('比較');expect(self.card('earlier')).to_be_visible();expect(self.card('recent')).to_have_count(0)
        search.fill('example.com/spec');expect(self.card('recent')).to_be_visible()
        self.card('recent').get_by_role('button',name='完了した設計',exact=True).click()
        expect(self.page.get_by_label('トークのタイトル',exact=True)).to_have_text('完了した設計')
        expect(self.entry('secret')).to_be_visible()
        search.fill('');board.get_by_role('button',name='未完了タスクを表示',exact=True).click()
        expect(self.card()).to_be_visible();expect(self.card('recent')).to_have_count(0)
        search.fill('完了して残す小作業');expect(self.card()).to_be_visible()
        search.fill('完了した設計');expect(self.card()).to_have_count(0)

    def test_completed_board_can_reopen_task_without_losing_history_or_child_completion(self):
        original=task(progressEnabled=True,progressStage='doing');original.update(completed=True,completedAt='2026-11-05T03:00:00Z')
        for st in original['subtasks']:st['completed']=True
        original['progressHistory']=[dict(id='history',kind='comment',text='完了後も保持する履歴',status='active',subtaskIds=[])]
        self.seed([original]);self.progress();expect(self.card()).to_have_count(0)
        self.page.get_by_role('button',name='完了済みタスクを表示',exact=True).click()
        self.select_chat()
        self.card().get_by_role('button',name='進捗テスト案件の完了を取り消す',exact=True).click()
        expect(self.card()).to_have_count(0)
        self.page.get_by_role('button',name='未完了タスクを表示',exact=True).click();expect(self.card()).to_be_visible()
        saved=self.stored()[0];self.assertFalse(saved['completed']);self.assertNotIn('completedAt',saved)
        self.assertTrue(all(st['completed'] for st in saved['subtasks']));self.assertEqual(saved['progressHistory'],original['progressHistory'])
        self.page.reload();self.progress();expect(self.card()).to_be_visible()

    def conversion_task(self):
        original=task(progressEnabled=True,progressStage='doing')
        original['subtasks'].append(dict(id='source',title='変換する作業',dueDate=FUTURE,completed=False))
        original['progressHistory']=[dict(id='origin',kind='comment',text=FUTURE+'までに【変換する作業】',createdAt='2026-11-01T01:00:00Z',status='active',addedSubtask=True,subtaskIds=['source'],subtaskTitles=['変換する作業'])]
        return original

    def start_todo_conversion(self,original):
        self.seed([original]);self.progress();self.select_chat()
        self.entry('origin').get_by_role('button',name='コメントを編集',exact=True).click()
        expect(self.page.get_by_label('やるべきことの追加',exact=True)).to_be_checked()
        self.page.get_by_label('小さいタスクの追加',exact=True).check()
        expect(self.page.get_by_label('やるべきことの追加',exact=True)).not_to_be_checked()

    def test_todo_creation_edit_converts_card_and_history_to_small_and_survives_backup(self):
        original=self.conversion_task();origin=original['progressHistory'][0]
        prefix=origin['text'].index('【')+1
        origin['textLinks']=[dict(start=prefix,end=len(origin['text'])-1,url='https://example.com/spec')]
        origin['images']=[dict(id='image',name='元の図面.png',src='data:image/png;base64,'+__import__('base64').b64encode(self.progress_png()).decode())]
        origin['links']=[dict(id='link',url='https://example.com/other',label='追加の資料')]
        progress=dict(id='progress',kind='comment',text='移動する途中のトーク',status='active',subtaskIds=['source'],subtaskTitles=['変換する作業'],quote=dict(origin))
        original['progressHistory'] += [progress,dict(progress,id='result',text='移動する結論',isConclusion=True,conclusionTarget=dict(subtaskIds=['source'],smallTaskId=None)),dict(progress,id='reply',text='引用も移動',quote=progress)]
        self.start_todo_conversion(original)
        expect(self.page.get_by_label('コメントの編集',exact=True)).to_have_text('変換する作業')
        expect(self.page.get_by_label('コメントの編集',exact=True).get_by_role('link')).to_have_attribute('href','https://example.com/spec')
        expect(self.page.get_by_role('button',name='編集を保存',exact=True)).to_be_disabled()
        self.page.get_by_label('変換先のやるべきこと',exact=True).select_option('s1')
        self.page.get_by_role('button',name='編集を保存',exact=True).click()
        after=self.stored()[0];small=after['subtasks'][0]['smallTasks'][0]
        self.assertEqual(len(after['subtasks']),2);self.assertEqual(small['id'],'source');self.assertEqual(small['title'],'変換する作業')
        self.assertNotIn('smallTasks',small);self.assertEqual(small['dueDate'],FUTURE)
        edited=next(e for e in after['progressHistory'] if e['id']=='origin')
        self.assertEqual(len(after['progressHistory']),4);self.assertEqual(edited['createdAt'],origin['createdAt'])
        self.assertFalse(edited['addedSubtask']);self.assertTrue(edited['addedSmallTask']);self.assertEqual(edited['text'],'変換する作業')
        self.assertEqual(edited['textLinks'],[dict(start=0,end=len('変換する作業'),url='https://example.com/spec')])
        self.assertEqual(edited['images'],origin['images']);self.assertEqual(edited['links'],origin['links'])
        for entry in after['progressHistory']:
            self.assertEqual(entry['subtaskIds'],['s1']);self.assertEqual(entry['smallTaskId'],'source')
        self.assertEqual(after['progressHistory'][2]['conclusionTarget'],dict(subtaskIds=['s1'],smallTaskId='source'))
        self.assertEqual(after['progressHistory'][3]['quote']['subtaskIds'],['s1'])
        self.assertEqual(after['progressHistory'][3]['quote']['smallTaskId'],'source')
        self.assertEqual(after['progressHistory'][3]['quote']['quote']['text'],origin['text'])
        expect(self.page.locator('[data-progress-subtask-id="source"]')).to_have_count(0)
        self.page.get_by_role('button',name='変換する作業のトークを表示',exact=True).click()
        expect(self.entry('progress')).to_be_visible();expect(self.entry('origin')).to_have_count(0)
        expect(self.page.get_by_label('トークのタイトル',exact=True)).to_have_text('変換する作業')
        self.send('変換後のコメント',expand_threads=False)
        self.assertEqual(self.stored()[0]['progressHistory'][-1]['smallTaskId'],'source')
        self.page.reload();self.progress();self.page.get_by_role('button',name='変換する作業のトークを表示',exact=True).click()
        expect(self.entry('progress')).to_be_visible()
        with self.page.expect_download() as download:self.page.get_by_role('button',name='エクスポート',exact=True).click()
        saved=Path(download.value.path()).read_bytes();self.seed([])
        self.page.get_by_label('バックアップをインポート',exact=True).set_input_files(dict(name='converted.json',mimeType='application/json',buffer=saved))
        expect(self.page.get_by_text('データをインポートしました',exact=True)).to_be_visible()
        self.progress();expect(self.page.locator('[data-progress-subtask-id="source"]')).to_have_count(0)
        expect(self.page.locator('[data-progress-small-task-id="source"]')).to_have_count(1)

    def test_todo_conversion_moves_children_and_preserves_waiting_dependencies(self):
        original=self.conversion_task();source=original['subtasks'][-1]
        source['smallTasks']=[dict(id='child',title='移動する既存の作業',waiting=True,completed=False),dict(id='done',title='既に完了した作業',completed=True,completedAt='2026-11-01T02:00:00Z',completionManaged=True,completionSource='manual')]
        original['subtasks'][0].update(completed=True,completedAt='2026-11-01T02:00:00Z')
        original['subtasks'][1]['dependencies']=[dict(kind='subtask',id='source',title=source['title']),dict(kind='waiting',scopeKind='small',parentId='source',id='child',title='移動する既存の作業')]
        original['progressHistory'] += [dict(id='wait',kind='comment',text='返答を待つ',status='waiting',subtaskIds=['source'],subtaskTitles=[source['title']]),dict(id='child-wait',kind='comment',text='子の回答を待つ',status='waiting',subtaskIds=['source'],subtaskTitles=[source['title']],smallTaskId='child',smallTaskTitle='移動する既存の作業')]
        self.start_todo_conversion(original)
        self.page.get_by_label('変換先のやるべきこと',exact=True).select_option('s1');self.page.get_by_role('button',name='編集を保存',exact=True).click()
        after=self.stored()[0];parent=after['subtasks'][0]
        self.assertFalse(parent['completed']);self.assertNotIn('completedAt',parent)
        self.assertEqual([small['id'] for small in parent['smallTasks']],['source','child','done'])
        self.assertTrue(parent['smallTasks'][0]['waiting']);self.assertTrue(parent['smallTasks'][1]['waiting']);self.assertTrue(parent['smallTasks'][2]['completed'])
        refs=after['subtasks'][1]['dependencies'];self.assertEqual(refs[0]['kind'],'small');self.assertEqual(refs[0]['parentId'],'s1');self.assertEqual(refs[1]['parentId'],'s1')
        dialog=self.dependency_dialog('期限切れの確認')
        expect(dialog.get_by_label('完了を待つ: 小さいタスク 変換する作業',exact=True)).to_be_checked()
        dialog.get_by_role('button',name='タスク待ちを保存',exact=True).click();expect(dialog).to_have_count(0)
        self.page.get_by_role('button',name='変換する作業のトークを表示',exact=True).click()
        self.reply('wait');self.send('回答を受け取った',expand_threads=False)
        self.page.get_by_role('button',name='変換する作業を完了',exact=True).click()
        self.assertTrue(self.stored()[0]['subtasks'][0]['smallTasks'][0]['completed'])
        self.page.get_by_role('button',name='移動する既存の作業のトークを表示',exact=True).click()
        self.reply('child-wait');self.send('子の回答も受け取った',expand_threads=False)
        dialog=self.dependency_dialog('期限切れの確認')
        expect(dialog.get_by_label('完了を待つ: 小さいタスク 変換する作業',exact=True)).to_be_checked()
        expect(dialog.get_by_role('group',name='タスクの完了待ち',exact=True)).to_contain_text('完了')
        expect(dialog.get_by_role('group',name='相手待ちの解除待ち',exact=True)).to_contain_text('解除済み')
        dialog.get_by_role('button',name='キャンセル',exact=True).click()
        self.page.reload();self.assertEqual(len(self.stored()[0]['subtasks'][0]['smallTasks']),3)

    def test_todo_conversion_keeps_completed_card_blue_and_can_reopen(self):
        for manual in [True,False]:
            with self.subTest(manual=manual):
                original=self.conversion_task();source=original['subtasks'][-1]
                source.update(completed=True,completedAt='2026-11-01T02:00:00Z',completionManaged=True)
                if manual:source['completionSource']='manual'
                else:
                    source['completionEntryId']='done'
                    original['progressHistory'].append(dict(id='done',kind='comment',text='過去の完了記録',status='completed',subtaskIds=['source'],subtaskTitles=[source['title']],completedSubtaskIds=['source']))
                self.start_todo_conversion(original);self.page.get_by_label('変換先のやるべきこと',exact=True).select_option('s1')
                self.page.get_by_role('button',name='編集を保存',exact=True).click()
                small=self.stored()[0]['subtasks'][0]['smallTasks'][0]
                self.assertTrue(small['completed']);self.assertEqual(small['completedAt'],source['completedAt'])
                expect(self.page.locator('[data-progress-small-task-id="source"]')).to_have_class(re.compile(r'\bbg-blue-50\b'))
                self.page.get_by_role('button',name='変換する作業のトークを表示',exact=True).click()
                self.page.get_by_role('button',name='変換する作業の完了を取り消す',exact=True).click()
                self.assertFalse(self.stored()[0]['subtasks'][0]['smallTasks'][0]['completed'])
                expect(self.page.locator('[data-progress-small-task-id="source"]')).to_have_class(re.compile(r'\bbg-purple-50\b'))
                self.page.reload();self.assertFalse(self.stored()[0]['subtasks'][0]['smallTasks'][0]['completed'])

    def test_todo_conversion_rejects_missing_parent_or_dependency_cycle_without_changes(self):
        for case in ['missing','cycle']:
            with self.subTest(case=case):
                original=self.conversion_task()
                if case=='missing':original['subtasks']=original['subtasks'][-1:]
                else:original['subtasks'][-1]['dependencies']=[dict(kind='subtask',id='s1',title='既存の調査')]
                self.start_todo_conversion(original);before=self.stored()
                if case=='cycle':self.page.get_by_label('変換先のやるべきこと',exact=True).select_option('s1')
                expect(self.page.get_by_role('alert')).to_contain_text('先に追加' if case=='missing' else '循環')
                expect(self.page.get_by_role('button',name='編集を保存',exact=True)).to_be_disabled()
                self.page.get_by_label('コメントの編集',exact=True).press('Control+Shift+Enter')
                self.assertEqual(self.stored(),before)
                self.page.get_by_role('button',name='編集をキャンセル',exact=True).click();self.assertEqual(self.stored(),before)

    def test_reediting_creation_checkboxes_updates_existing_cards_without_duplicates(self):
        self.seed([self.conversion_task()]);self.progress();self.select_chat()
        self.entry('origin').get_by_role('button',name='コメントを編集',exact=True).click()
        self.page.get_by_label('コメントの編集',exact=True).fill('変更した作業名')
        self.page.get_by_label('追加するやるべきことの期限',exact=True).fill(LATER)
        self.page.get_by_role('button',name='編集を保存',exact=True).click()
        after=self.stored()[0];self.assertEqual(len(after['subtasks']),3);self.assertEqual(after['subtasks'][-1]['title'],'変更した作業名');self.assertEqual(after['subtasks'][-1]['dueDate'],LATER)
        self.entry('origin').get_by_role('button',name='コメントを編集',exact=True).click();self.page.get_by_label('小さいタスクの追加',exact=True).check()
        self.page.get_by_label('変換先のやるべきこと',exact=True).select_option('s1');self.page.get_by_role('button',name='編集を保存',exact=True).click()
        self.entry('origin').get_by_role('button',name='コメントを編集',exact=True).click();self.page.get_by_label('小さいタスクの追加',exact=True).check()
        self.page.get_by_label('コメントの編集',exact=True).fill('再編集した作業名');self.page.get_by_role('button',name='編集を保存',exact=True).click()
        after=self.stored()[0];self.assertEqual(len(after['subtasks']),2);self.assertEqual(len(after['subtasks'][0]['smallTasks']),1)
        self.assertEqual(after['subtasks'][0]['smallTasks'][0]['title'],'再編集した作業名');self.assertEqual(after['progressHistory'][0]['smallTaskId'],'source')

    def test_todo_conversion_preserves_custom_text_in_older_creation_comments(self):
        original=self.conversion_task()
        original['progressHistory'][0]['text']='担当者と再確認した古い追加コメントの本文'
        self.start_todo_conversion(original)
        expect(self.page.get_by_label('コメントの編集',exact=True)).to_have_text(original['progressHistory'][0]['text'])
        self.page.get_by_label('変換先のやるべきこと',exact=True).select_option('s1')
        self.page.get_by_role('button',name='編集を保存',exact=True).click()
        self.assertEqual(self.stored()[0]['progressHistory'][0]['text'],original['progressHistory'][0]['text'])

    def test_ordinary_progress_never_closes_waiting_and_only_waiting_replies_resolve_it(self):
        for scope in ['task','subtask','small']:
            with self.subTest(scope=scope):
                original=task(progressEnabled=True,progressStage='doing')
                owner=original if scope=='task' else original['subtasks'][0]
                if scope=='small':
                    owner=dict(id='a',title='返答待ちの小作業',waiting=True);original['subtasks'][0]['smallTasks']=[owner]
                owner['waiting']=True
                def wait(id,text):return dict(id=id,kind='comment',status='waiting',text=text,subtaskIds=[] if scope=='task' else ['s1'],subtaskTitles=[] if scope=='task' else ['既存の調査'],**(dict(smallTaskId='a',smallTaskTitle=owner['title']) if scope=='small' else {}))
                original['progressHistory']=[wait('w1','質問1の返答待ち'),wait('w2','質問2の返答待ち')]
                self.seed([original]);self.progress()
                if scope=='task':self.select_chat()
                else:self.page.get_by_role('button',name=('返答待ちの小作業' if scope=='small' else '既存の調査')+'のトークを表示',exact=True).click()
                self.send('返答とは無関係の進捗',expand_threads=False);progress=self.stored()[0]['progressHistory'][-1]
                self.reply(progress['id']);self.send('進捗への補足返信',expand_threads=False)
                result=self.stored()[0]
                for id in ['w1','w2']:self.assertNotIn('resolvedByReplyId',next(e for e in result['progressHistory'] if e['id']==id))
                self.reply('w1');self.send('質問1の回答を受領',expand_threads=False)
                result=self.stored()[0];self.assertIn('resolvedByReplyId',next(e for e in result['progressHistory'] if e['id']=='w1'))
                self.assertNotIn('resolvedByReplyId',next(e for e in result['progressHistory'] if e['id']=='w2'))
                current=result if scope=='task' else result['subtasks'][0]
                if scope=='small':current=current['smallTasks'][0]
                self.assertTrue(current['waiting'])
                self.reply('w2');self.page.get_by_label('相手待ち',exact=True).check();self.send('追加の返答待ち',expand_threads=False)
                followup=self.stored()[0]['progressHistory'][-1]
                self.reply(followup['id']);self.send('すべての回答を受領',expand_threads=False)
                self.page.reload();self.progress();result=self.stored()[0]
                current=result if scope=='task' else result['subtasks'][0]
                if scope=='small':current=current['smallTasks'][0]
                self.assertFalse(current['waiting'])

    def test_loading_repairs_waits_closed_by_unquoted_progress_but_keeps_real_closures(self):
        def wait(id,closer):return dict(id=id,kind='comment',status='waiting',text=id,subtaskIds=['s1'],subtaskTitles=['既存の調査'],resolvedByReplyId=closer)
        bad=wait('bad','progress');good=wait('good','reply');manual=wait('manual','waiting-cleared-in-settings')
        original=task(progressEnabled=True,progressStage='doing',progressHistory=[bad,good,manual,
            dict(id='progress',kind='comment',status='active',text='普通の進捗',subtaskIds=['s1'],subtaskTitles=['既存の調査']),
            dict(id='reply',kind='comment',status='active',text='実際の返信',subtaskIds=['s1'],subtaskTitles=['既存の調査'],quote=good)])
        original['subtasks'][0]['waiting']=False
        self.seed([original]);self.progress();result=self.stored()[0]
        self.assertNotIn('resolvedByReplyId',next(e for e in result['progressHistory'] if e['id']=='bad'))
        self.assertEqual(next(e for e in result['progressHistory'] if e['id']=='good')['resolvedByReplyId'],'reply')
        self.assertEqual(next(e for e in result['progressHistory'] if e['id']=='manual')['resolvedByReplyId'],'waiting-cleared-in-settings')
        self.assertTrue(result['subtasks'][0]['waiting'])
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click();self.send('さらに進捗を記録',expand_threads=False)
        self.assertTrue(self.stored()[0]['subtasks'][0]['waiting'])

    def test_waiting_from_deleted_small_tasks_repairs_parent_and_resolves_individually(self):
        original=task(progressEnabled=True,progressStage='doing',deletedProgressSmallTaskIds=['gone'],deletedSmallTaskOriginIds=['gone'])
        original['subtasks'][0]['waiting']=False
        original['progressHistory']=[dict(id=id,kind='comment',text=text,status='waiting',smallTaskId='gone',smallTaskTitle='削除した小作業',subtaskIds=['s1'],subtaskTitles=['既存の調査']) for id,text in [('w1','日程の回答待ち'),('w2','仕様の回答待ち')]]
        self.seed([original]);self.progress();parent=self.page.locator('[data-progress-subtask-id="s1"]')
        expect(parent).to_have_class(re.compile(r'\bbg-green-50\b'))
        dialog=self.dependency_dialog('期限切れの確認')
        expect(dialog.get_by_text('仕様の回答待ち',exact=True)).to_be_visible()
        dialog.get_by_role('button',name='キャンセル',exact=True).click()
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
        self.reply('w1');self.send('日程の回答を受領',expand_threads=False)
        expect(parent).to_have_class(re.compile(r'\bbg-green-50\b'))
        self.reply('w2');self.send('仕様の回答も受領',expand_threads=False)
        expect(parent).to_have_class(re.compile(r'\bbg-purple-50\b'))
        self.page.reload();self.progress();expect(parent).to_have_class(re.compile(r'\bbg-purple-50\b'))
        self.assertFalse(self.stored()[0]['subtasks'][0]['waiting'])
        self.assertEqual(self.stored()[0]['subtasks'][0].get('smallTasks',[]),[])

    def test_send_mode_shortcuts_and_premises_pinned_with_no_own_creation_row(self):
        self.seed([task(progressEnabled=True,progressStage='doing')]);self.progress()
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
        self.page.get_by_label('送信ショートカットの説明',exact=True).click()
        expect(self.page.get_by_text('Ctrl+Shift+Alt+Enter',exact=True)).to_be_visible()
        self.page.get_by_label('送信ショートカットの説明',exact=True).click()
        for key,text,field in [('Alt+Enter','相手に質問','waiting'),('Shift+Enter','補足だけ','plainComment'),('Control+Shift+Enter','小さい作業','addedSmallTask'),('Control+Alt+Enter','次のやるべきこと','addedSubtask'),('Control+Shift+Alt+Enter','最初に示す前提','assumptionMemo')]:
            box=self.page.get_by_label('進捗コメント',exact=True);box.fill(text);box.press(key);expect(box).to_have_text('')
            entry=self.stored()[0]['progressHistory'][-1]
            self.assertTrue(entry['status']=='waiting' if field=='waiting' else entry[field])
        memo=self.stored()[0]['progressHistory'][-1]
        log=self.page.get_by_role('log',name='進捗履歴')
        self.assertEqual(log.locator('[data-progress-entry-id]').first.get_attribute('data-progress-entry-id'),memo['id'])
        self.assertEqual(log.locator('[data-progress-entry-id]').filter(has_text='やるべきことの追加').count(),0)
        self.page.get_by_role('button',name='小さい作業のトークを表示',exact=True).click()
        expect(log.get_by_text('小さいタスクの追加',exact=True)).to_have_count(0)
        self.page.get_by_label('進捗コメント',exact=True).fill('通常の進捗');self.page.get_by_label('進捗コメント',exact=True).press('Control+Enter')
        expect(log.get_by_text('通常の進捗',exact=True)).to_be_visible()
        self.page.get_by_label('進捗コメント',exact=True).fill('子の前提');self.page.get_by_label('進捗コメント',exact=True).press('Control+Shift+Alt+Enter')
        self.assertEqual(log.locator('[data-progress-entry-id]').first.get_attribute('data-progress-entry-id'),self.stored()[0]['progressHistory'][-1]['id'])
        self.select_chat();self.page.get_by_label('進捗コメント',exact=True).fill('全体の前提');self.page.get_by_label('進捗コメント',exact=True).press('Control+Shift+Alt+Enter')
        self.assertEqual(log.locator('[data-progress-entry-id]').first.get_attribute('data-progress-entry-id'),self.stored()[0]['progressHistory'][-1]['id'])

    def test_settings_can_clear_repaired_wait_without_it_reappearing_on_reload(self):
        original=task(progressEnabled=True,progressStage='doing',deletedProgressSmallTaskIds=['gone'],deletedSmallTaskOriginIds=['gone'])
        original['progressHistory']=[dict(id='wait',kind='comment',text='消した小タスクの回答待ち',status='waiting',smallTaskId='gone',subtaskIds=['s1'],subtaskTitles=['既存の調査'])]
        self.seed([original]);self.progress()
        self.card().get_by_role('button',name='進捗テスト案件の設定',exact=True).click()
        dialog=self.page.get_by_role('dialog',name='進捗の設定',exact=True)
        dialog.get_by_label('相手待ち',exact=True).first.uncheck();dialog.get_by_role('button',name='確定',exact=True).click()
        self.assertFalse(self.stored()[0]['subtasks'][0]['waiting']);self.assertEqual(len(self.stored()[0]['progressHistory']),1)
        self.page.reload();self.progress()
        expect(self.page.locator('[data-progress-subtask-id="s1"]')).to_have_class(re.compile(r'\bbg-purple-50\b'))

    def test_expanded_talk_selection_controls_send_scope_and_remains_selected(self):
        original=task(progressEnabled=True,progressStage='doing')
        original['subtasks'][0]['smallTasks']=[dict(id='a',title='送信先の小作業')]
        original['progressHistory']=[dict(id='small-note',kind='comment',text='選択する進捗',status='active',subtaskIds=['s1'],subtaskTitles=['既存の調査'],smallTaskId='a',smallTaskTitle='送信先の小作業')]
        self.seed([original]);self.progress();self.select_chat();self.entry('small-note').get_by_text('選択する進捗',exact=True).click()
        expect(self.entry('small-note')).to_have_attribute('aria-current','true')
        expect(self.page.get_by_label('コメントの送信先',exact=True)).to_contain_text('送信先の小作業')
        self.send('選択先への追記');self.assertEqual(self.stored()[0]['progressHistory'][-1]['smallTaskId'],'a')
        self.page.get_by_label('小さいタスクの追加',exact=True).check();self.page.get_by_label('小さいタスクの追加',exact=True).uncheck()
        self.send('選択先を続ける');self.assertEqual(self.stored()[0]['progressHistory'][-1]['smallTaskId'],'a')
        self.page.get_by_role('button',name='表示中の範囲に戻す',exact=True).click();self.send('大タスクへの追記')
        self.assertIsNone(self.stored()[0]['progressHistory'][-1].get('smallTaskId'))
        self.assertEqual(self.entry('small-note').locator(':scope > div').evaluate('el=>getComputedStyle(el).borderTopColor'),'rgb(100, 116, 139)')

    def test_small_task_drag_reorders_within_parent_and_persists(self):
        original=task(progressEnabled=True,progressStage='doing')
        original['subtasks'][0]['smallTasks']=[dict(id='a',title='先頭'),dict(id='b',title='後ろ',completed=True)]
        original['subtasks'][1]['smallTasks']=[dict(id='outside',title='別の親の小作業')]
        self.seed([original]);self.progress()
        self.page.get_by_role('button',name='後ろのトークを表示',exact=True).drag_to(self.page.get_by_role('button',name='先頭のトークを表示',exact=True))
        self.assertEqual([s['id'] for s in self.stored()[0]['subtasks'][0]['smallTasks']],['b','a'])
        self.page.get_by_role('button',name='後ろのトークを表示',exact=True).drag_to(self.page.get_by_role('button',name='別の親の小作業のトークを表示',exact=True))
        self.assertEqual([s['id'] for s in self.stored()[0]['subtasks'][0]['smallTasks']],['b','a'])
        self.page.reload();self.progress();self.assertEqual([s['id'] for s in self.stored()[0]['subtasks'][0]['smallTasks']],['b','a'])

    def test_premise_memos_are_gray_neutral_and_editable_without_resolving_waits(self):
        original=task(progressEnabled=True,progressStage='doing')
        original['subtasks'][0]['smallTasks']=[dict(id='a',title='前提を残す作業',waiting=True)]
        original['progressHistory']=[dict(id='waiting',kind='comment',text='回答待ち',status='waiting',smallTaskId='a',smallTaskTitle='前提を残す作業',subtaskIds=['s1'],subtaskTitles=['既存の調査'])]
        self.seed([original]);self.progress();self.page.get_by_role('button',name='前提を残す作業のトークを表示',exact=True).click()
        self.reply('waiting');self.page.get_by_label('前提メモ',exact=True).check()
        expect(self.page.get_by_label('相手待ち',exact=True)).to_be_disabled()
        expect(self.page.get_by_label('小さいタスクの追加',exact=True)).to_be_disabled()
        self.send('そもそも締結トルクが有効かを確認する https://example.com/basis',expand_threads=False)
        memo=self.stored()[0]['progressHistory'][-1]
        self.assertTrue(memo['assumptionMemo']);self.assertFalse(memo['plainComment'])
        self.assertTrue(self.stored()[0]['subtasks'][0]['smallTasks'][0]['waiting'])
        self.assertNotIn('resolvedByReplyId',self.stored()[0]['progressHistory'][0])
        expect(self.entry(memo['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-gray-50\b'))
        expect(self.entry(memo['id']).get_by_text('前提メモ',exact=True)).to_be_visible()
        self.entry(memo['id']).get_by_role('button',name='コメントを編集',exact=True).click()
        expect(self.page.get_by_label('前提メモ',exact=True)).to_be_checked()
        expect(self.page.get_by_label('ただのコメント',exact=True)).not_to_be_checked()
        self.page.get_by_label('ただのコメント',exact=True).check()
        expect(self.page.get_by_label('前提メモ',exact=True)).not_to_be_checked()
        self.page.get_by_role('button',name='編集を保存',exact=True).click()
        self.entry(memo['id']).get_by_role('button',name='コメントを編集',exact=True).click()
        expect(self.page.get_by_label('ただのコメント',exact=True)).to_be_checked()
        self.page.get_by_label('前提メモ',exact=True).check();self.page.get_by_role('button',name='編集を保存',exact=True).click()
        self.reply(memo['id']);self.send('前提について補足',expand_threads=False)
        reply=self.stored()[0]['progressHistory'][-1]
        self.assertTrue(reply['quote']['assumptionMemo'])
        self.reply('waiting');self.send('相手からの回答を受領',expand_threads=False)
        self.page.get_by_role('button',name='前提を残す作業を完了',exact=True).click()
        expect(self.entry(memo['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-gray-50\b'))
        self.page.reload();self.progress();self.page.get_by_role('button',name='前提を残す作業のトークを表示',exact=True).click()
        expect(self.entry(reply['id']).get_by_role('blockquote').get_by_text('前提メモ',exact=True)).to_be_visible()
        with self.page.expect_download() as download:self.page.get_by_role('button',name='エクスポート',exact=True).click()
        backup=Path(download.value.path()).read_bytes();self.seed([])
        self.page.get_by_label('バックアップをインポート',exact=True).set_input_files(dict(name='premises.json',mimeType='application/json',buffer=backup))
        expect(self.page.get_by_text('データをインポートしました',exact=True)).to_be_visible()
        self.progress();self.page.get_by_role('button',name='前提を残す作業のトークを表示',exact=True).click()
        expect(self.entry(memo['id']).get_by_text('前提メモ',exact=True)).to_be_visible()

    def test_reports_distinguish_premises_from_progress_and_include_prior_context(self):
        import base64,io,zipfile,xml.etree.ElementTree as ET
        png='data:image/png;base64,'+base64.b64encode(self.progress_png()).decode()
        def record(id,text,at,**extra):return dict(id=id,kind='comment',text=text,createdAt=at,status='note',subtaskIds=['s1'],subtaskTitles=['既存の調査'],**extra)
        records=[record('past','期間前からの検証の前提 https://example.com/premise','2000-01-01T01:00:00Z',assumptionMemo=True,images=[dict(id='img',name='前提図.png',src=png)]),
            record('current','期間内に追加した前提',TODAY.isoformat()+'T01:00:00Z',assumptionMemo=True),
            record('future','未来の前提は含めない','2099-01-01T01:00:00Z',assumptionMemo=True),
            record('note','期間外の通常コメントは含めない','2000-01-01T01:00:00Z',plainComment=True)]
        progress=record('progress','実際に検証した内容',TODAY.isoformat()+'T01:00:00Z');progress['status']='active';records.append(progress)
        self.seed([task(progressEnabled=True,progressStage='doing',progressHistory=records)])
        dialog=self.open_report(start=TODAY.isoformat(),end=TODAY.isoformat());_,body=self.download_report(dialog)
        for text in ['期間前からの検証の前提','期間内に追加した前提','前提メモ（背景情報・実績ではない）','進捗記録: 1件','通常コメント: 0件','前提メモ（期間内）: 1件','前提図.png']:self.assertIn(text,body)
        for text in ['未来の前提は含めない','期間外の通常コメントは含めない']:self.assertNotIn(text,body)
        dialog=self.open_report(start=TODAY.isoformat(),end=TODAY.isoformat())
        with self.page.expect_download() as download:dialog.get_by_role('button',name='Wordをダウンロード',exact=True).click()
        with zipfile.ZipFile(io.BytesIO(Path(download.value.path()).read_bytes())) as archive:
            root=ET.fromstring(archive.read('word/document.xml'));text=''.join(root.itertext())
            self.assertIn('期間前からの検証の前提',text);self.assertIn('期間内に追加した前提',text)
            self.assertNotIn('未来の前提は含めない',text)
            self.assertEqual(len([name for name in archive.namelist() if name.startswith('word/media/')]),1)

    def test_renaming_todo_updates_comment_classification_and_report_by_id(self):
        origin=dict(id='origin',kind='comment',text=FUTURE+'までに【旧タイトル】',status='active',addedSubtask=True,subtaskIds=['s1'],subtaskTitles=['旧タイトル'],createdAt=TODAY.isoformat()+'T01:00:00Z')
        memo=dict(origin,id='memo',text='前提として残す背景',addedSubtask=False,assumptionMemo=True,status='note',createdAt='2000-01-01T01:00:00Z')
        child=dict(origin,id='child-note',text='小さいタスクの記録',addedSubtask=False,smallTaskId='a',smallTaskTitle='配下の作業')
        removed=dict(origin,id='removed-note',text='削除済みの項目の記録',addedSubtask=False,subtaskIds=['removed'],subtaskTitles=['削除済みの旧項目'])
        original=task(progressEnabled=True,progressStage='doing',progressHistory=[origin,memo,child,removed])
        original['subtasks'][0].update(title='旧タイトル',smallTasks=[dict(id='a',title='配下の作業')])
        self.seed([original]);self.progress();self.select_chat()
        self.card().get_by_role('button',name='進捗テスト案件の設定',exact=True).click()
        dialog=self.page.get_by_role('dialog',name='進捗の設定',exact=True)
        dialog.get_by_label('やるべきこと 1',exact=True).fill('固定資産シールを貼る')
        dialog.get_by_role('button',name='確定',exact=True).click();self.expand_talks()
        for id in ['origin','memo','child-note']:
            expect(self.entry(id).locator('[data-progress-subtask-label="s1"]')).to_have_text('固定資産シールを貼る')
        expect(self.entry('removed-note').locator('[data-progress-subtask-label="removed"]')).to_have_text('削除済みの旧項目')
        self.assertEqual(self.stored()[0]['progressHistory'],original['progressHistory'])
        self.page.get_by_label('履歴を検索',exact=True).fill('固定資産シールを貼る')
        expect(self.entry('memo')).to_be_visible()
        self.page.reload();self.progress();self.select_chat()
        expect(self.entry('memo').locator('[data-progress-subtask-label="s1"]')).to_have_text('固定資産シールを貼る')
        dialog=self.open_report(start=TODAY.isoformat(),end=TODAY.isoformat());_,body=self.download_report(dialog)
        self.assertIn('固定資産シールを貼る [s1]',body)
        self.assertNotIn('旧タイトル [s1]',body)
        self.assertIn('削除済みの旧項目 [removed]',body)

    def test_word_report_is_default_and_embeds_images_hyperlinks_and_scoped_history(self):
        import io,zipfile,xml.etree.ElementTree as ET,base64
        png='data:image/png;base64,'+base64.b64encode(self.progress_png()).decode()
        entry=dict(id='word-entry',kind='comment',text='結果の資料 https://example.com/result?a=1&b=2',status='active',createdAt=TODAY.isoformat()+'T01:00:00Z',subtaskIds=['s1'],subtaskTitles=['既存の調査'],images=[dict(id='png',name='測定結果.png',src=png)],links=[dict(id='named',label='確認仕様書',url='https://example.org/spec')],quote=dict(id='old',text='引用した前提',createdAt='2000-01-01T01:00:00Z',images=[dict(id='quoted',name='引用の画像.png',src=png)]))
        original=task(progressEnabled=True,progressStage='doing',progressHistory=[entry],resultImages=[png],richResult='<p>成果メモ</p><img alt="成果画像" src="'+png+'">')
        outside=dict(entry,id='outside',text='期間外の画像',createdAt='2000-01-01T01:00:00Z',quote=None,images=[dict(id='outside-image',name='期間外.png',src=png)])
        original['progressHistory'].append(outside)
        self.seed([original]);before=self.stored();dialog=self.open_report(start=TODAY.isoformat(),end=TODAY.isoformat())
        expect(dialog.get_by_label('レポート出力形式',exact=True)).to_have_value('docx')
        with self.page.expect_download() as download:dialog.get_by_role('button',name='Wordをダウンロード',exact=True).click()
        self.assertTrue(download.value.suggested_filename.endswith('.docx'))
        raw=Path(download.value.path()).read_bytes();Path('/tmp/taskmatrix-word-report.docx').write_bytes(raw)
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            self.assertIsNone(archive.testzip())
            for name in ['[Content_Types].xml','_rels/.rels','word/document.xml','word/_rels/document.xml.rels']:ET.fromstring(archive.read(name))
            ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
            root=ET.fromstring(archive.read('word/document.xml'));text='\n'.join(el.text or '' for el in root.findall('.//w:t',ns))
            for value in ['Copilotへの依頼','既存の調査','測定結果.png','引用の画像.png','確認仕様書','引用した前提','成果メモ']:self.assertIn(value,text)
            self.assertTrue(any('確認仕様書' in ''.join(el.itertext()) for el in root.findall('.//w:hyperlink',ns)))
            self.assertNotIn('期間外.png',text);self.assertNotIn('data:image',text)
            media=[name for name in archive.namelist() if name.startswith('word/media/')];self.assertEqual(len(media),4)
            for name in media:self.assertTrue(archive.read(name).startswith(b'\x89PNG'))
            rels=ET.fromstring(archive.read('word/_rels/document.xml.rels'))
            urls=[item.attrib['Target'] for item in rels if item.attrib.get('TargetMode')=='External']
            self.assertIn('https://example.com/result?a=1&b=2',urls);self.assertIn('https://example.org/spec',urls)
        self.assertEqual(self.stored(),before)

    def test_progress_todo_cards_reorder_by_drag_and_persist_without_moving_tasks(self):
        original=task(progressEnabled=True,progressStage='doing',progressHistory=[dict(id='saved',kind='comment',text='保持する記録',subtaskIds=['s1'],subtaskTitles=['既存の調査'])])
        original['subtasks'].append(dict(id='s3',title='最後のやるべきこと',dueDate=FUTURE,completed=True))
        original['subtasks'][0]['smallTasks']=[dict(id='child',title='一緒に移動する小さいタスク',completed=True)]
        other=task('other',progressEnabled=True,progressStage='todo')
        self.seed([original,other]);self.progress()
        self.card().get_by_role('button',name='最後のやるべきことのトークを表示',exact=True).drag_to(self.card().get_by_role('button',name='既存の調査のトークを表示',exact=True))
        result=self.stored()[0]
        self.assertEqual([st['id'] for st in result['subtasks']],['s3','s1','s2'])
        self.assertEqual(result['progressStage'],'doing');self.assertEqual(result['progressHistory'],original['progressHistory'])
        self.assertEqual([{key: small[key] for key in ['id','title','completed']} for small in result['subtasks'][1]['smallTasks']],original['subtasks'][0]['smallTasks'])
        before=self.stored()
        self.card().get_by_role('button',name='最後のやるべきことのトークを表示',exact=True).drag_to(self.card('other').get_by_role('button',name='既存の調査のトークを表示',exact=True))
        self.assertEqual(self.stored(),before)
        self.page.reload();self.progress()
        self.assertEqual(self.card().locator('[data-progress-subtask-id]').evaluate_all('(els)=>els.map(el=>el.dataset.progressSubtaskId)'),['s3','s1','s2'])
        self.card().get_by_role('button',name='最後のやるべきことのトークを表示',exact=True).click()
        expect(self.page.get_by_label('トークのタイトル',exact=True)).to_have_text('最後のやるべきこと')

    def test_manual_completion_survives_deleting_older_completion_comments(self):
        old=dict(id='old',kind='comment',status='completed',text='旧完了記録',subtaskIds=['s1'],subtaskTitles=['既存の調査'],smallTaskId='a',smallTaskTitle='再完了した作業')
        original=task(progressEnabled=True,progressStage='doing',progressHistory=[old])
        original['subtasks'][0]['smallTasks']=[dict(id='a',title='再完了した作業',completed=True)]
        self.seed([original]);self.progress();self.page.get_by_role('button',name='再完了した作業のトークを表示',exact=True).click()
        self.page.get_by_role('button',name='再完了した作業の完了を取り消す',exact=True).click()
        self.page.get_by_role('button',name='再完了した作業を完了',exact=True).click()
        self.entry('old').get_by_role('button',name='コメントを削除',exact=True).click()
        self.assertTrue(self.stored()[0]['subtasks'][0]['smallTasks'][0]['completed'])
        self.page.reload();self.progress();self.assertTrue(self.stored()[0]['subtasks'][0]['smallTasks'][0]['completed'])

    def test_completion_buttons_do_not_post_comments_and_persist_without_history_sources(self):
        original=task(progressEnabled=True,progressStage='doing')
        original['subtasks'][0]['smallTasks']=[dict(id='a',title='コメントせず完了する作業')]
        self.seed([original]);self.progress();self.page.get_by_role('button',name='コメントせず完了する作業のトークを表示',exact=True).click()
        self.page.get_by_label('結論',exact=True).check();self.send('明示的に残した結論',expand_threads=False)
        history=self.stored()[0]['progressHistory']
        self.page.get_by_role('button',name='コメントせず完了する作業を完了',exact=True).click()
        result=self.stored()[0];self.assertEqual(result['progressHistory'],history)
        self.assertTrue(result['subtasks'][0]['smallTasks'][0]['completed']);self.assertTrue(result['subtasks'][0]['smallTasks'][0]['completedAt'])
        self.page.get_by_role('button',name='既存の調査を完了',exact=True).click()
        self.assertEqual(self.stored()[0]['progressHistory'],history);self.assertTrue(self.stored()[0]['subtasks'][0]['completed'])
        self.page.reload();self.progress();self.page.get_by_role('button',name='コメントせず完了する作業のトークを表示',exact=True).click()
        expect(self.page.get_by_role('button',name='コメントせず完了する作業の完了を取り消す',exact=True)).to_be_visible()
        self.page.get_by_role('button',name='コメントせず完了する作業の完了を取り消す',exact=True).click()
        result=self.stored()[0];self.assertFalse(result['subtasks'][0]['completed']);self.assertFalse(result['subtasks'][0]['smallTasks'][0]['completed'])
        self.assertEqual(result['progressHistory'],history)
        self.page.reload();self.progress();self.page.get_by_role('button',name='コメントせず完了する作業のトークを表示',exact=True).click()
        self.page.get_by_role('button',name='コメントせず完了する作業を完了',exact=True).click()
        self.assertTrue(self.stored()[0]['subtasks'][0]['smallTasks'][0]['completed'])
        dialog=self.open_report(start=TODAY.isoformat(),end=TODAY.isoformat());_,body=self.download_report(dialog)
        self.assertIn('期間内の項目の完了',body);self.assertIn('コメントせず完了する作業',body)

    def test_compact_thread_controls_titles_and_automatic_comment_targets(self):
        original=task(progressEnabled=True,progressStage='doing')
        original['subtasks'][0]['smallTasks']=[dict(id='a',title='表示中の小さい作業')]
        self.seed([original]);self.progress();self.select_chat()
        panel=self.page.get_by_role('region',name='進捗リストボード',exact=True)
        title=self.page.get_by_label('トークのタイトル',exact=True)
        expect(title).to_have_text(original['title'])
        expect(panel.get_by_role('combobox')).to_have_count(0)
        expect(panel.get_by_role('group',name='関連するやるべきことを選択',exact=True)).to_have_count(0)
        expect(self.page.get_by_label('追加するやるべきことの期限',exact=True)).to_have_count(0)
        expect(self.page.get_by_label('小さいタスクの追加',exact=True)).to_be_disabled()
        self.send('大タスク自身の進捗',expand_threads=False)
        self.assertEqual(self.stored()[0]['progressHistory'][-1]['subtaskIds'],[])
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
        expect(title).to_have_text('既存の調査')
        self.send('やるべきこと自身の進捗',expand_threads=False)
        record=self.stored()[0]['progressHistory'][-1]
        self.assertEqual(record['subtaskIds'],['s1']);self.assertIsNone(record.get('smallTaskId'))
        self.page.get_by_role('button',name='表示中の小さい作業のトークを表示',exact=True).click()
        expect(title).to_have_text('表示中の小さい作業')
        self.send('小さいタスク自身の進捗',expand_threads=False)
        record=self.stored()[0]['progressHistory'][-1]
        self.assertEqual(record['subtaskIds'],['s1']);self.assertEqual(record['smallTaskId'],'a')
        toolbar=panel.get_by_label('トーク操作',exact=True)
        expect(toolbar.get_by_label('履歴を検索',exact=True)).to_be_visible()
        toolbar.get_by_role('button',name='表示中の小さい作業を完了',exact=True).click()
        toolbar.get_by_role('button',name='表示中の小さい作業の完了を取り消す',exact=True).click()
        self.assertFalse(self.stored()[0]['subtasks'][0]['smallTasks'][0]['completed'])
        expect(title).not_to_contain_text(FUTURE);expect(title).not_to_contain_text('進行可能')
        self.assertEqual(title.get_by_role('heading').count(),1)

    def test_compact_composer_keeps_checkboxes_together_and_frees_history_space(self):
        original=task(progressEnabled=True,progressStage='doing')
        original['subtasks'][0]['smallTasks']=[dict(id='a',title='サイズ確認')]
        self.seed([original]);self.progress();self.page.get_by_role('button',name='サイズ確認のトークを表示',exact=True).click()
        panel=self.page.get_by_role('region',name='進捗リストボード',exact=True)
        options=panel.get_by_role('group',name='送信オプション',exact=True)
        expect(options.get_by_role('checkbox')).to_have_count(6)
        for width,height in [(1800,1000),(1300,750),(390,700)]:
            with self.subTest(width=width,height=height):
                self.page.set_viewport_size(dict(width=width,height=height))
                panel.scroll_into_view_if_needed()
                boxes=options.get_by_role('checkbox').evaluate_all('(els)=>els.map(el=>({top:Math.round(el.getBoundingClientRect().top),left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right}))')
                self.assertLessEqual(len(set(box['top'] for box in boxes)),1 if width==1800 else 2)
                form=panel.get_by_role('form',name='トーク送信',exact=True).bounding_box()
                log=panel.get_by_role('log',name='進捗履歴').bounding_box()
                self.assertLessEqual(form['height'],145)
                self.assertGreater(log['height'],form['height']*(1 if width==390 else 2))
                self.page.get_by_label('進捗コメント',exact=True).fill('狭い画面から送信')
                panel.get_by_role('button',name='送信',exact=True).click()
                expect(self.page.get_by_label('進捗コメント',exact=True)).to_have_text('')

    def test_addition_mode_cancellation_restores_small_scope_and_conditional_due_date(self):
        original=task(progressEnabled=True,progressStage='doing')
        original['subtasks'][0]['smallTasks']=[dict(id='a',title='元の小さい作業')]
        self.seed([original]);self.progress();self.page.get_by_role('button',name='元の小さい作業のトークを表示',exact=True).click()
        for mode in ['やるべきことの追加','小さいタスクの追加']:
            self.page.get_by_label(mode,exact=True).check()
            expect(self.page.get_by_label('追加するやるべきことの期限',exact=True)).to_have_count(1 if mode=='やるべきことの追加' else 0)
            self.page.get_by_label(mode,exact=True).uncheck();self.send('通常のコメントに戻す',expand_threads=False)
            self.assertEqual(self.stored()[0]['progressHistory'][-1]['smallTaskId'],'a')
        self.page.get_by_label('小さいタスクの追加',exact=True).check();self.send('同じ親に追加する作業',expand_threads=False)
        result=self.stored()[0];self.assertEqual(len(result['subtasks'][0]['smallTasks']),2)
        self.assertEqual(result['subtasks'][0]['smallTasks'][-1]['title'],'同じ親に追加する作業')
        self.page.get_by_label('やるべきことの追加',exact=True).check()
        self.page.get_by_label('追加するやるべきことの期限',exact=True).fill(LATER);self.send('別のやるべきこと',expand_threads=False)
        self.assertEqual(self.stored()[0]['subtasks'][-1]['dueDate'],LATER)
        self.assertEqual(self.stored()[0]['progressHistory'][-1]['text'],LATER+'までに【別のやるべきこと】')

    def test_reply_cancel_and_quote_navigation_return_to_the_visible_comment_target(self):
        original=task(progressEnabled=True,progressStage='doing')
        original['subtasks'][0]['smallTasks']=[dict(id='a',title='元の作業')]
        self.seed([original]);self.progress();self.page.get_by_role('button',name='元の作業のトークを表示',exact=True).click()
        self.send('引用する元の進捗',expand_threads=False);source=self.stored()[0]['progressHistory'][-1]
        self.reply(source['id']);self.page.get_by_label('進捗コメント',exact=True).fill('返信先は元の作業のまま')
        self.page.get_by_role('button',name='期限切れの確認のトークを表示',exact=True).click()
        self.page.get_by_role('button',name='送信',exact=True).click();reply=self.stored()[0]['progressHistory'][-1]
        self.assertEqual(reply['smallTaskId'],'a');self.assertEqual(reply['subtaskIds'],['s1'])
        self.page.get_by_role('button',name='元の作業のトークを表示',exact=True).click();self.reply(source['id'])
        self.page.get_by_label('進捗コメント',exact=True).fill('返信をやめて今の画面に送る')
        self.page.get_by_role('button',name='期限切れの確認のトークを表示',exact=True).click()
        self.page.get_by_role('button',name='返信をキャンセル',exact=True).click()
        expect(self.page.get_by_label('進捗コメント',exact=True)).to_have_text('返信をやめて今の画面に送る')
        self.page.get_by_role('button',name='送信',exact=True).click()
        record=self.stored()[0]['progressHistory'][-1]
        self.assertEqual(record['subtaskIds'],['s2']);self.assertIsNone(record.get('smallTaskId'));self.assertIsNone(record.get('quote'))
        self.page.get_by_role('button',name='元の作業のトークを表示',exact=True).click()
        self.page.get_by_label('進捗コメント',exact=True).fill('大タスクのコメントとして保存')
        self.entry(reply['id']).get_by_role('button',name='引用元へ移動: 引用する元の進捗',exact=True).click()
        expect(self.page.get_by_label('トークのタイトル',exact=True)).to_have_text('進捗テスト案件')
        self.page.get_by_role('button',name='送信',exact=True).click()
        record=self.stored()[0]['progressHistory'][-1]
        self.assertEqual(record['subtaskIds'],[]);self.assertIsNone(record.get('smallTaskId'))

    def test_explicit_small_conclusions_are_multiple_and_independent_of_completion(self):
        original=task(progressEnabled=True,progressStage='doing')
        original['subtasks'][0]['smallTasks']=[dict(id='a',title='結論を選ぶ作業',completed=False)]
        self.seed([original]);self.progress()
        self.page.get_by_role('button',name='結論を選ぶ作業のトークを表示',exact=True).click()
        expect(self.page.get_by_role('checkbox',name='完了',exact=True)).to_have_count(0)
        self.send('途中の報告',expand_threads=False);ordinary=self.stored()[0]['progressHistory'][-1]
        self.page.get_by_label('結論',exact=True).check();self.send('第一の結論\n補足',expand_threads=False)
        first=self.stored()[0]['progressHistory'][-1]
        self.assertTrue(first['isConclusion']);self.assertFalse(self.stored()[0]['subtasks'][0]['smallTasks'][0]['completed'])
        expect(self.page.get_by_label('結論',exact=True)).not_to_be_checked()
        self.page.get_by_label('ただのコメント',exact=True).check();self.page.get_by_label('結論',exact=True).check()
        self.send('第二の結論 https://example.com/result',expand_threads=False);second=self.stored()[0]['progressHistory'][-1]
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
        summary=self.page.locator('[data-small-task-conclusion="a"]')
        expect(summary).to_have_text(first['text']+'\n'+second['text'])
        expect(summary).not_to_contain_text(ordinary['text'])
        expect(summary.get_by_role('link')).to_have_attribute('href','https://example.com/result')
        self.page.get_by_role('button',name='結論を選ぶ作業のトークを表示',exact=True).click()
        self.page.get_by_role('button',name='結論を選ぶ作業を完了',exact=True).click()
        card=self.page.locator('[data-progress-small-task-id="a"]');expect(card).to_have_class(re.compile(r'\bbg-blue-50\b'))
        self.assertEqual(self.stored()[0]['progressHistory'][-1],second)
        self.entry(first['id']).get_by_role('button',name='コメントを編集',exact=True).click()
        self.page.get_by_label('コメントの編集',exact=True).fill('結論を補足');self.page.get_by_role('button',name='編集を保存',exact=True).click()
        self.assertTrue(self.stored()[0]['subtasks'][0]['smallTasks'][0]['completed'])
        self.page.get_by_role('button',name='結論を選ぶ作業の完了を取り消す',exact=True).click()
        expect(card).to_have_class(re.compile(r'\bbg-purple-50\b'))
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
        expect(summary).to_have_text('結論を補足\n'+second['text'])
        self.page.reload();self.progress();self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
        expect(summary).to_have_text('結論を補足\n'+second['text'])

    def test_todo_conclusions_use_explicit_direct_comments_and_update_on_uncheck_or_delete(self):
        original=task(progressEnabled=True,progressStage='doing')
        original['subtasks'][0]['smallTasks']=[dict(id='a',title='配下の作業')]
        self.seed([original]);self.progress();self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
        self.page.get_by_label('結論',exact=True).check();self.send('親の結論その1',expand_threads=False);first=self.stored()[0]['progressHistory'][-1]
        self.send('親の結論その2',expand_threads=False);second=self.stored()[0]['progressHistory'][-1]
        self.entry(second['id']).get_by_label('このコメントを結論にする',exact=True).check()
        self.page.get_by_role('button',name='配下の作業のトークを表示',exact=True).click()
        self.page.get_by_label('結論',exact=True).check();self.send('子だけの結論',expand_threads=False)
        self.select_chat(expand_threads=False)
        parent=self.page.locator('[data-todo-thread-id="s1"]')
        parent.get_by_role('button',name='既存の調査のトークを折りたたむ',exact=True).click()
        summary=parent.locator('[data-todo-task-conclusion="s1"]')
        expect(summary).to_have_text('親の結論その1\n親の結論その2');expect(parent).not_to_contain_text('子だけの結論')
        parent.get_by_role('button',name='結論1を編集',exact=True).click()
        self.page.get_by_label('結論',exact=True).uncheck();self.page.get_by_role('button',name='編集を保存',exact=True).click()
        expect(summary).to_have_text('親の結論その2')
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
        self.entry(second['id']).get_by_role('button',name='コメントを削除',exact=True).click()
        self.select_chat(expand_threads=False);expect(summary).to_have_count(0)
        self.assertFalse(self.stored()[0]['subtasks'][0]['completed'])
        with self.page.expect_download() as download:self.page.get_by_role('button',name='エクスポート',exact=True).click()
        backup=Path(download.value.path()).read_bytes()
        self.seed([]);self.page.get_by_label('バックアップをインポート',exact=True).set_input_files(dict(name='conclusions.json',mimeType='application/json',buffer=backup))
        self.progress();self.page.get_by_role('button',name='配下の作業のトークを表示',exact=True).click()
        expect(self.page.get_by_role('log',name='進捗履歴')).to_contain_text('子だけの結論')
        self.assertTrue(self.stored()[0]['progressHistory'][-1]['isConclusion'])

    def test_completion_does_not_imply_conclusion_for_new_or_legacy_tasks(self):
        completed=dict(id='old-done',kind='comment',text='旧バージョンの完了本文',status='completed',smallTaskId='old',smallTaskTitle='過去の完了',subtaskIds=['s1'],subtaskTitles=['既存の調査'])
        original=task(progressEnabled=True,progressStage='doing',progressHistory=[completed])
        original['subtasks'][0]['smallTasks']=[dict(id='old',title='過去の完了',completed=True),dict(id='new',title='結論なしの完了')]
        self.seed([original]);self.progress();self.page.get_by_role('button',name='結論なしの完了のトークを表示',exact=True).click()
        expect(self.page.get_by_role('button',name='送信',exact=True)).to_be_disabled()
        self.page.get_by_label('結論',exact=True).check();expect(self.page.get_by_role('button',name='送信',exact=True)).to_be_disabled()
        self.page.get_by_role('button',name='結論なしの完了を完了',exact=True).click()
        self.page.get_by_role('button',name='既存の調査を完了',exact=True).click()
        self.select_chat(expand_threads=False)
        expect(self.page.locator('[data-small-task-conclusion]')).to_have_count(0)
        expect(self.page.locator('[data-todo-task-conclusion]')).to_have_count(0)
        expect(self.page.get_by_text('結論は未記録です。',exact=True)).to_have_count(0)
        self.page.get_by_role('button',name='過去の完了のトークを表示',exact=True).click()
        self.entry('old-done').get_by_label('このコメントを結論にする',exact=True).check()
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
        expect(self.page.locator('[data-small-task-conclusion="old"]')).to_have_text('旧バージョンの完了本文')

    def test_small_completion_button_respects_waits_dependencies_and_reopening(self):
        original=task(progressEnabled=True,progressStage='doing')
        original['subtasks'][0]['smallTasks']=[dict(id='a',title='先行作業'),dict(id='b',title='後続作業',dependencies=[dict(kind='small',parentId='s1',id='a',title='先行作業')])]
        self.seed([original]);self.progress();self.page.get_by_role('button',name='後続作業のトークを表示',exact=True).click()
        expect(self.page.get_by_role('button',name='後続作業を完了',exact=True)).to_be_disabled()
        self.page.get_by_role('button',name='先行作業のトークを表示',exact=True).click()
        self.page.get_by_role('button',name='先行作業を完了',exact=True).click()
        self.page.get_by_role('button',name='後続作業のトークを表示',exact=True).click()
        expect(self.page.get_by_role('button',name='後続作業を完了',exact=True)).to_be_enabled()
        self.page.get_by_label('相手待ち',exact=True).check();self.send('返答待ちです',expand_threads=False);waiting=self.stored()[0]['progressHistory'][-1]
        expect(self.page.get_by_role('button',name='後続作業を完了',exact=True)).to_be_disabled()
        self.reply(waiting['id']);self.send('回答が来たので進めます',expand_threads=False)
        expect(self.page.get_by_role('button',name='後続作業を完了',exact=True)).to_be_enabled()
        self.assertFalse(self.stored()[0]['subtasks'][0]['smallTasks'][1].get('completed',False))
        self.page.get_by_role('button',name='後続作業を完了',exact=True).click()
        expect(self.page.get_by_role('button',name='既存の調査を完了',exact=True)).to_be_visible()
        self.page.get_by_role('button',name='既存の調査を完了',exact=True).click()
        self.page.get_by_role('button',name='先行作業のトークを表示',exact=True).click()
        self.page.get_by_role('button',name='先行作業の完了を取り消す',exact=True).click()
        result=self.stored()[0];self.assertFalse(result['subtasks'][0]['completed'])
        self.assertFalse(result['subtasks'][0]['smallTasks'][0]['completed'])
        self.page.reload();self.progress();self.page.get_by_role('button',name='先行作業のトークを表示',exact=True).click()
        expect(self.page.get_by_role('button',name='先行作業を完了',exact=True)).to_be_enabled()

    def test_waiting_replies_continue_or_close_without_completing_and_keep_conclusion_scope(self):
        for scope in ['todo','small']:
            for addition in ['やるべきことの追加','小さいタスクの追加']:
                with self.subTest(scope=scope,addition=addition):
                    source=dict(id='wait',kind='comment',text='回答依頼',status='waiting',subtaskIds=['s1'],subtaskTitles=['既存の調査'])
                    original=task(progressEnabled=True,progressStage='doing',progressHistory=[source])
                    if scope=='small':
                        source.update(smallTaskId='a',smallTaskTitle='待っていた作業')
                        original['subtasks'][0]['smallTasks']=[dict(id='a',title='待っていた作業',waiting=True,completed=False)]
                    else:original['subtasks'][0]['waiting']=True
                    self.seed([original]);self.progress();self.select_chat();self.reply('wait')
                    self.page.get_by_label('相手待ち',exact=True).check();self.page.get_by_label('結論',exact=True).check()
                    self.send('部分的な結論',expand_threads=False);partial=self.stored()[0]['progressHistory'][-1]
                    current=self.stored()[0]['subtasks'][0]
                    if scope=='small':current=current['smallTasks'][0]
                    self.assertTrue(current['waiting']);self.assertFalse(current['completed'])
                    self.expand_talks();self.reply(partial['id'])
                    self.page.get_by_label(addition,exact=True).check();self.page.get_by_label('結論',exact=True).check()
                    self.send('次に必要な作業',expand_threads=False);result=self.stored()[0];next_record=result['progressHistory'][-1]
                    current=result['subtasks'][0]
                    if scope=='small':current=current['smallTasks'][0]
                    self.assertFalse(current['waiting']);self.assertFalse(current['completed'])
                    next_work=result['subtasks'][-1] if addition=='やるべきことの追加' else result['subtasks'][0]['smallTasks'][-1]
                    self.assertFalse(next_work['completed']);self.assertFalse(next_work['waiting'])
                    self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
                    if scope=='small': summary=self.page.locator('[data-small-task-conclusion="a"]')
                    else:
                        self.select_chat(expand_threads=False);summary=self.page.locator('[data-todo-task-conclusion="s1"]')
                    expect(summary).to_have_text(partial['text']+'\n'+next_record['text'])
                    self.page.get_by_label('返信済みの相手待ちの表示',exact=True).select_option('hide')
                    expect(summary).to_have_text(partial['text']+'\n'+next_record['text'])
                    self.page.get_by_label('返信済みの相手待ちの表示',exact=True).select_option('show')
                    self.page.get_by_role('button',name='待っていた作業のトークを表示' if scope=='small' else '既存の調査のトークを表示',exact=True).click()
                    expect(self.entry(next_record['id'])).to_be_visible()
                    self.entry(next_record['id']).get_by_role('button',name='コメントを編集',exact=True).click()
                    self.page.get_by_label('結論',exact=True).uncheck();self.page.get_by_role('button',name='編集を保存',exact=True).click()
                    self.assertFalse(next(entry for entry in self.stored()[0]['progressHistory'] if entry['id']==next_record['id'])['isConclusion'])

    def test_conclusions_preserve_named_hyperlinks_and_images_and_cancel_is_nonmutating(self):
        self.seed([task(progressEnabled=True,progressStage='doing')]);self.progress()
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
        self.paste_rich_link('<a href="https://example.com/final">最終仕様書</a>','最終仕様書')
        self.page.get_by_label('結論',exact=True).check()
        # Real clipboard image paste, retaining the draft's named hyperlink.
        self.ctx.grant_permissions(['clipboard-read','clipboard-write'])
        self.page.evaluate('''async data=>{const blob=await(await fetch(data)).blob();await navigator.clipboard.write([new ClipboardItem({'image/png':blob})])}''','data:image/png;base64,'+__import__('base64').b64encode(self.progress_png()).decode())
        self.page.get_by_label('進捗コメント',exact=True).press('Control+v')
        expect(self.page.get_by_label('本文の添付プレビュー')).to_be_visible()
        self.page.get_by_role('button',name='送信',exact=True).click();record=self.stored()[0]['progressHistory'][-1]
        self.select_chat(expand_threads=False);summary=self.page.locator('[data-todo-task-conclusion="s1"]')
        expect(summary.get_by_role('link',name='最終仕様書',exact=True)).to_have_attribute('href','https://example.com/final')
        expect(summary.get_by_role('img')).to_have_count(1)
        self.page.locator('[data-todo-thread-id="s1"]').get_by_role('button',name='結論を編集',exact=True).click()
        self.page.get_by_label('結論',exact=True).uncheck();self.page.get_by_label('コメントの編集',exact=True).fill('保存しない変更')
        self.page.get_by_role('button',name='編集をキャンセル',exact=True).click()
        self.assertEqual(self.stored()[0]['progressHistory'][-1],record)
        expect(summary.get_by_role('link',name='最終仕様書',exact=True)).to_be_visible()

    def test_waiting_reply_can_complete_source_and_add_next_todo(self):
        source=dict(id='waiting',kind='comment',createdAt='2026-01-01T01:00:00.000Z',
                    text='返答待ち',status='waiting',subtaskIds=['s1'],subtaskTitles=['既存の調査'])
        original=task(progressEnabled=True,progressStage='doing',progressHistory=[source])
        original['subtasks'][0]['waiting']=True
        self.seed([original]);self.progress();self.select_chat();self.reply('waiting')
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
        self.page.get_by_label('小さいタスクの追加',exact=True).check()
        self.send('回答に沿って実施')
        result=self.stored()[0]
        all_small=result['subtasks'][0]['smallTasks']
        self.assertFalse(next(item for item in all_small if item['id']=='old')['completed'])
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
        self.page.get_by_role('button',name='完了対象を完了',exact=True).click()
        expect(row).to_have_class(re.compile(r'\bbg-blue-50\b'))
        result=self.stored()[0]
        self.assertTrue(result['subtasks'][0]['smallTasks'][0]['completed'])
        self.assertEqual(len(result['progressHistory']),3)
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
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click();self.expand_talks()
        expect(self.entry('親の記録')).to_be_visible()
        expect(self.entry('別親の記録')).to_have_count(0)
        self.page.locator('[data-progress-small-task-id="a"]').click()
        expect(self.entry('小作業Aの記録')).to_be_visible()
        expect(self.entry('親の記録')).to_have_count(0)
        expect(self.entry('小作業Bの記録')).to_have_count(0)
        self.page.locator('[data-progress-small-task-id="b"]').click()
        expect(self.entry('小作業Bの記録')).to_be_visible()
        expect(self.entry('小作業Aの記録')).to_have_count(0)
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click();self.expand_talks()
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
                self.page.get_by_role('button',name='編集を保存',exact=True).click()
                expect(self.page.get_by_label('コメントの編集',exact=True)).to_have_count(0)
                if prior_status=='active':self.page.get_by_role('button',name='照合作業を完了',exact=True).click()
                result=self.stored()[0]
                self.assertEqual([small['id'] for small in result['subtasks'][0]['smallTasks']],['small','keep'])
                self.assertTrue(result['subtasks'][0]['smallTasks'][0]['completed'])
                self.assertFalse(result['subtasks'][0]['completed'])
                self.assertEqual(result['progressHistory'][0],addition)
                self.assertEqual(result['progressHistory'][1]['quote'],quoted)
                self.assertEqual(result['progressHistory'][1]['status'],prior_status)
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
        self.page.get_by_role('button',name='確認作業を完了',exact=True).click()
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
        self.page.get_by_role('button',name='確認作業の完了を取り消す',exact=True).click()
        self.assertNotIn('small',self.stored()[0]['completedSmallTaskIds'])
        self.assertFalse(self.stored()[0]['subtasks'][0]['smallTasks'][0]['completed'])
        expect(self.page.locator('[data-progress-small-task-id="small"]')).to_have_class(re.compile(r'\bbg-purple-50\b'))
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
        self.assertNotIn('small',self.stored()[0]['completedSmallTaskIds'])
        expect(self.entry('メモ').locator(':scope > div')).to_have_class(re.compile(r'\bbg-gray-50\b'))

    def test_parent_completion_button_waits_for_all_children_and_closes_parent(self):
        original=task(progressEnabled=True,progressStage='doing')
        original['subtasks'][0]['smallTasks']=[dict(id='a',title='作業A'),dict(id='b',title='作業B',waiting=True)]
        original['progressHistory']=[dict(id='wait-b',kind='comment',text='Bの返答待ち',status='waiting',subtaskIds=['s1'],subtaskTitles=['既存の調査'],smallTaskId='b',smallTaskTitle='作業B')]
        self.seed([original]);self.progress()
        complete=self.page.get_by_role('button',name='既存の調査を完了',exact=True)
        expect(complete).to_have_count(0)
        self.page.get_by_role('button',name='作業Aのトークを表示',exact=True).click()
        self.page.get_by_role('button',name='作業Aを完了',exact=True).click()
        expect(complete).to_have_count(0)
        self.page.get_by_role('button',name='作業Bのトークを表示',exact=True).click()
        self.reply('wait-b');self.send('回答を受領');self.page.get_by_role('button',name='作業Bを完了',exact=True).click()
        expect(complete).to_be_visible()
        complete.click()
        expect(complete).to_have_count(0)
        result=self.stored()[0]
        self.assertTrue(result['subtasks'][0]['completed']);self.assertFalse(result['completed'])
        card=self.page.locator('[data-progress-subtask-id="s1"]')
        expect(card).to_have_class(re.compile(r'\bbg-blue-50\b'))
        self.select_chat()
        expect(self.page.get_by_role('log').locator('[data-progress-entry-id] > div.bg-blue-50')).to_have_count(2)
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
            parent.click();self.expand_talks()
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
        self.page.get_by_role('button',name='作業Bのトークを表示',exact=True).click()
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
        for name,color in [('全体','blue'),('返答待ち','green'),('期限超過','blue')]:
            expect(self.entry(name).locator(':scope > div')).to_have_class(re.compile(r'\bbg-'+color+r'-50\b'))
        original.update(completed=True)
        self.seed([original]);self.progress();self.page.get_by_role('button',name='完了済みタスクを表示',exact=True).click();self.select_chat()
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
                self.assertEqual(result['subtasks'][0].get('waiting',False),bool(parent));self.assertEqual(result.get('waiting',False),not bool(parent))

    def dependency_dialog(self, title):
        self.page.get_by_role('button',name=title+'のタスク待ちを設定',exact=True).click()
        return self.page.get_by_role('dialog',name='タスク待ちの設定',exact=True)

    def test_waiting_dependency_choices_show_only_the_matching_comment_body(self):
        import base64
        original=task(progressEnabled=True,progressStage='doing',waiting=True)
        original['subtasks'][0]['smallTasks']=[dict(id='a',title='図面の確認',waiting=True),dict(id='b',title='確認後の作業')]
        original['subtasks'][1]['waiting']=True
        def waiting(id,text,parents=None,small=None,**extra):return dict(id=id,kind='comment',text=text,status='waiting',createdAt=TODAY.isoformat()+'T01:00:00Z',subtaskIds=parents or [],subtaskTitles=['既存の調査'] if parents==['s1'] else ['期限切れの確認'] if parents else [],smallTaskId=small,**extra)
        image=dict(id='img',name='選択欄には出さない画像.png',src='data:image/png;base64,'+base64.b64encode(self.progress_png()).decode())
        original['progressHistory']=[waiting('global','全体の見積回答を待っています'),waiting('parent','シールの発行回答を待っています',['s2']),
            waiting('old','解除済みの古い依頼は表示しない',['s1'],'a',resolvedByReplyId='new'),
            waiting('small','図面の寸法確認の回答を待っています',['s1'],'a',images=[image],links=[dict(id='link',label='添付仕様書は表示しない',url='https://example.com/attachment')]),
            waiting('premise','前提メモは待ち本文に使わない',['s1'],'a',assumptionMemo=True)]
        self.seed([original]);self.progress();before=self.stored();dialog=self.dependency_dialog('確認後の作業')
        for text in ['全体の見積回答を待っています','シールの発行回答を待っています','図面の寸法確認の回答を待っています']:expect(dialog.get_by_text(text,exact=True)).to_be_visible()
        for text in ['解除済みの古い依頼は表示しない','前提メモは待ち本文に使わない','添付仕様書は表示しない']:expect(dialog.get_by_text(text,exact=True)).to_have_count(0)
        preview=dialog.locator('[data-dependency-option="waiting:small:s1:a"]').get_by_label('相手待ちの内容',exact=True)
        expect(preview).to_have_text('図面の寸法確認の回答を待っています')
        expect(preview.locator('time,img,a,button')).to_have_count(0)
        choice=dialog.get_by_label('解除を待つ: 相手待ち 図面の確認',exact=True)
        preview.click();expect(choice).not_to_be_checked();self.assertEqual(self.stored(),before)
        choice.check();dialog.get_by_role('button',name='タスク待ちを保存',exact=True).click()
        self.page.get_by_role('button',name='図面の確認のトークを表示',exact=True).click();self.reply('small');self.send('確認の回答を受領')
        expect(self.page.locator('[data-progress-small-task-id="b"]')).to_have_class(re.compile(r'\bbg-purple-50\b'))
        dialog=self.dependency_dialog('確認後の作業')
        expect(dialog.get_by_label('解除を待つ: 相手待ち 図面の確認',exact=True)).to_be_checked()
        expect(dialog.get_by_text('図面の寸法確認の回答を待っています',exact=True)).to_be_visible()
        dialog.get_by_role('button',name='キャンセル',exact=True).click()

    def test_waiting_dependencies_release_on_reply_for_all_scopes_without_task_completion(self):
        for target_kind in ['small','subtask']:
            for source_kind in ['task','subtask','small']:
                with self.subTest(target=target_kind,source=source_kind):
                    original=task(progressEnabled=True,progressStage='doing');original['subtasks'][1]['dueDate']=FUTURE
                    if target_kind=='small':original['subtasks'][0]['smallTasks']=[dict(id='b',title='返答後に進める作業',completed=False)]
                    source_parent=original['subtasks'][0] if target_kind=='small' and source_kind=='small' else original['subtasks'][1]
                    source=original if source_kind=='task' else source_parent
                    if source_kind=='small':
                        source=dict(id='a',title='返答待ちの小さい作業',completed=False)
                        source_parent.setdefault('smallTasks',[]).append(source)
                    source['waiting']=True
                    waiting=dict(id='waiting',kind='comment',text='確認の返答を待つ',status='waiting',subtaskIds=[] if source_kind=='task' else [source_parent['id']],subtaskTitles=[] if source_kind=='task' else [source_parent['title']])
                    if source_kind=='small':waiting.update(smallTaskId='a',smallTaskTitle=source['title'])
                    original['progressHistory']=[waiting]
                    self.seed([original]);self.progress()
                    title='返答後に進める作業' if target_kind=='small' else '既存の調査'
                    dialog=self.dependency_dialog(title)
                    dialog.get_by_label('解除を待つ: 相手待ち '+source['title'],exact=True).check()
                    dialog.get_by_role('button',name='タスク待ちを保存',exact=True).click()
                    card=self.page.locator('[data-progress-small-task-id="b"]' if target_kind=='small' else '[data-progress-subtask-id="s1"]')
                    expect(card).to_have_class(re.compile(r'\bbg-yellow-50\b'))
                    self.select_chat();self.reply('waiting');self.page.get_by_label('相手待ち',exact=True).check();self.send('追加の返答を待つ')
                    next_wait=self.stored()[0]['progressHistory'][-1]
                    expect(card).to_have_class(re.compile(r'\bbg-yellow-50\b'))
                    self.reply(next_wait['id']);self.send('返答を受領したので開始できる')
                    expect(card).to_have_class(re.compile(r'\bbg-purple-50\b'))
                    result=self.stored()[0]
                    current=result if source_kind=='task' else result['subtasks'][0 if source_parent['id']=='s1' else 1]
                    if source_kind=='small':current=next(small for small in current['smallTasks'] if small['id']=='a')
                    self.assertFalse(current['waiting']);self.assertFalse(current['completed'])
                    dialog=self.dependency_dialog(title)
                    expect(dialog.get_by_label('解除を待つ: 相手待ち '+source['title'],exact=True)).to_be_checked()
                    expect(dialog.get_by_role('group',name='相手待ちの解除待ち',exact=True)).to_contain_text('解除済み')
                    dialog.get_by_role('button',name='タスク待ちを保存',exact=True).click()
                    self.page.reload();self.progress();expect(card).to_have_class(re.compile(r'\bbg-purple-50\b'))
        with self.page.expect_download() as download:self.page.get_by_role('button',name='エクスポート',exact=True).click()
        backup=Path(download.value.path()).read_bytes()
        self.seed([]);self.page.get_by_label('バックアップをインポート',exact=True).set_input_files(dict(name='waiting-dependencies.json',mimeType='application/json',buffer=backup))
        expect(self.page.get_by_text('データをインポートしました',exact=True)).to_be_visible()
        self.progress();expect(self.page.locator('[data-progress-subtask-id="s1"]')).to_have_class(re.compile(r'\bbg-purple-50\b'))
        self.assertEqual(self.stored()[0]['subtasks'][0]['dependencies'],result['subtasks'][0]['dependencies'])

    def test_waiting_release_and_task_completion_can_be_required_separately(self):
        original=task(progressEnabled=True,progressStage='doing');original['subtasks'][1].update(dueDate=FUTURE,waiting=True)
        original['subtasks'][0]['smallTasks']=[dict(id='b',title='両条件を待つ作業')]
        original['progressHistory']=[dict(id='wait',kind='comment',text='回答を依頼',status='waiting',subtaskIds=['s2'],subtaskTitles=['期限切れの確認'])]
        self.seed([original]);self.progress();dialog=self.dependency_dialog('両条件を待つ作業')
        dialog.get_by_label('完了を待つ: やるべきこと 期限切れの確認',exact=True).check()
        dialog.get_by_label('解除を待つ: 相手待ち 期限切れの確認',exact=True).check()
        dialog.get_by_role('button',name='タスク待ちを保存',exact=True).click()
        card=self.page.locator('[data-progress-small-task-id="b"]');expect(card).to_have_class(re.compile(r'\bbg-yellow-50\b'))
        self.assertEqual(len(self.stored()[0]['subtasks'][0]['smallTasks'][0]['dependencies']),2)
        self.select_chat();self.reply('wait');self.send('回答は受領、作業は継続')
        expect(card).to_have_class(re.compile(r'\bbg-yellow-50\b'))
        self.page.get_by_role('button',name='期限切れの確認を完了',exact=True).click()
        expect(card).to_have_class(re.compile(r'\bbg-purple-50\b'))

    def test_linking_waiting_dependencies_preserves_own_wait_and_updates_after_edit(self):
        original=task(progressEnabled=True,progressStage='doing')
        original['subtasks'][0]['smallTasks']=[dict(id='a',title='先方への照会',waiting=True),dict(id='b',title='自分も回答待ち',waiting=True),dict(id='c',title='回答を使う作業')]
        original['progressHistory']=[dict(id=id,kind='comment',text=text,status='waiting',smallTaskId=id,smallTaskTitle=title,subtaskIds=['s1'],subtaskTitles=['既存の調査']) for id,title,text in [('a','先方への照会','先方の回答待ち'),('b','自分も回答待ち','自分の確認も回答待ち')]]
        self.seed([original]);self.progress();dialog=self.dependency_dialog('回答を使う作業')
        dialog.get_by_label('解除を待つ: 相手待ち 自分も回答待ち',exact=True).check();dialog.get_by_role('button',name='タスク待ちを保存',exact=True).click()
        dialog=self.dependency_dialog('自分も回答待ち')
        expect(dialog.get_by_label('解除を待つ: 相手待ち 自分も回答待ち',exact=True)).to_have_count(0)
        dialog.get_by_label('解除を待つ: 相手待ち 先方への照会',exact=True).check();dialog.get_by_role('button',name='タスク待ちを保存',exact=True).click()
        self.assertTrue(self.stored()[0]['subtasks'][0]['smallTasks'][1]['waiting'])
        b=self.page.locator('[data-progress-small-task-id="b"]');c=self.page.locator('[data-progress-small-task-id="c"]')
        expect(b).to_have_class(re.compile(r'\bbg-yellow-50\b'));expect(c).to_have_class(re.compile(r'\bbg-yellow-50\b'))
        self.page.get_by_role('button',name='先方への照会のトークを表示',exact=True).click();self.reply('a');self.send('回答を受領')
        reply=self.stored()[0]['progressHistory'][-1]
        expect(b).to_have_class(re.compile(r'\bbg-green-50\b'));expect(c).to_have_class(re.compile(r'\bbg-yellow-50\b'))
        self.entry(reply['id']).get_by_role('button',name='コメントを編集',exact=True).click();self.page.get_by_label('相手待ち',exact=True).check();self.page.get_by_role('button',name='編集を保存',exact=True).click()
        expect(b).to_have_class(re.compile(r'\bbg-yellow-50\b'))
        self.entry(reply['id']).get_by_role('button',name='コメントを編集',exact=True).click();self.page.get_by_label('相手待ち',exact=True).uncheck();self.page.get_by_role('button',name='編集を保存',exact=True).click()
        expect(b).to_have_class(re.compile(r'\bbg-green-50\b'))
        self.page.get_by_role('button',name='自分も回答待ちのトークを表示',exact=True).click();self.reply('b');self.send('自分の回答も受領')
        expect(b).to_have_class(re.compile(r'\bbg-purple-50\b'));expect(c).to_have_class(re.compile(r'\bbg-purple-50\b'))

    def test_deleted_waiting_dependency_remains_blocked_until_removed_and_cancel_is_safe(self):
        original=task(progressEnabled=True,progressStage='doing')
        original['subtasks'][0]['smallTasks']=[dict(id='a',title='削除される回答待ち',waiting=True),dict(id='b',title='参照する作業')]
        self.seed([original]);self.progress();dialog=self.dependency_dialog('参照する作業')
        dialog.get_by_label('解除を待つ: 相手待ち 削除される回答待ち',exact=True).check();dialog.get_by_role('button',name='タスク待ちを保存',exact=True).click()
        self.page.get_by_role('button',name='削除される回答待ちを削除',exact=True).click()
        card=self.page.locator('[data-progress-small-task-id="b"]');expect(card).to_have_class(re.compile(r'\bbg-yellow-50\b'))
        before=self.stored();dialog=self.dependency_dialog('参照する作業')
        expect(dialog).to_contain_text('削除された関連先')
        dialog.get_by_label('解除を待つ: 相手待ち 削除される回答待ち',exact=True).uncheck();dialog.get_by_role('button',name='キャンセル',exact=True).click()
        self.assertEqual(self.stored(),before)
        dialog=self.dependency_dialog('参照する作業');dialog.get_by_label('解除を待つ: 相手待ち 削除される回答待ち',exact=True).uncheck();dialog.get_by_role('button',name='タスク待ちを保存',exact=True).click()
        expect(card).to_have_class(re.compile(r'\bbg-purple-50\b'))

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
        expect(self.page.get_by_role('button',name='後続作業を完了',exact=True)).to_be_disabled()
        expect(self.page.get_by_role('button',name='後続作業を完了',exact=True)).to_have_attribute('title',re.compile('先行作業'))
        self.send('先行作業を待って準備中')
        waiting_record=self.stored()[0]['progressHistory'][-1]
        self.reply(waiting_record['id'])
        self.page.get_by_label('小さいタスクの追加',exact=True).check()
        expect(self.page.get_by_role('button',name='後続作業を完了',exact=True)).to_be_disabled()
        self.page.get_by_role('button',name='返信をキャンセル',exact=True).click()
        self.page.get_by_label('小さいタスクの追加',exact=True).uncheck()
        self.page.get_by_role('button',name='先行作業のトークを表示',exact=True).click()
        self.page.get_by_role('button',name='先行作業を完了',exact=True).click()
        expect(card).to_have_class(re.compile(r'\bbg-purple-50\b'))
        self.page.get_by_role('button',name='後続作業のトークを表示',exact=True).click()
        expect(self.page.get_by_role('button',name='後続作業を完了',exact=True)).to_be_enabled()
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
        self.page.get_by_role('button',name='作業Aを完了',exact=True).click()
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
               waiting('resolved','解除済みの返答待ち','s2',resolvedByReplyId='waiting-cleared-in-settings'),waiting('deleted','削除済み項目の返答待ち','s1','missing',resolvedByReplyId='waiting-cleared-in-settings'),
               waiting('memo','表示しない通常メモ','s1','a',plainComment=True,editedAt='2026-11-05T01:00:00Z')]
        original=task(progressEnabled=True,progressStage='doing',waiting=True,progressHistory=notes)
        original['subtasks'][0].update(waiting=True,smallTasks=[dict(id='a',title='資料確認',waiting=True),dict(id='done',title='完了した作業',waiting=True,completed=True)])
        self.seed([original]);self.progress()
        before=self.stored()
        root=self.page.get_by_role('button',name='進捗テスト案件の相手待ち一覧',exact=True)
        expect(root).to_contain_text('4')
        root.click()
        dialog=self.page.get_by_role('dialog',name='相手待ちステータス一覧',exact=True)
        expect(dialog.locator('[data-waiting-status-key]')).to_have_count(4)
        for text in ['全体の返答待ち','調査の返答待ち','以前の資料待ち','最新の資料待ち']: expect(dialog).to_contain_text(text)
        for text in ['解除済みの返答待ち','削除済み項目の返答待ち','表示しない通常メモ']: expect(dialog).not_to_contain_text(text)
        close=dialog.get_by_role('button',name='相手待ち一覧を閉じる',exact=True)
        expect(close).to_be_focused()
        close.press('Shift+Tab');expect(dialog.get_by_role('button',name='閉じる',exact=True)).to_be_focused()
        dialog.get_by_role('button',name='閉じる',exact=True).press('Tab');expect(close).to_be_focused()
        close.press('Escape');expect(dialog).to_have_count(0);expect(root).to_be_focused()
        expect(self.page.get_by_role('log',name='進捗履歴')).to_have_count(0)
        self.page.get_by_role('button',name='既存の調査の相手待ち一覧',exact=True).click()
        expect(dialog.locator('[data-waiting-status-key]')).to_have_count(3)
        expect(dialog).not_to_contain_text('全体の返答待ち')
        dialog.get_by_role('button',name='閉じる',exact=True).click()
        self.page.get_by_role('button',name='資料確認の相手待ち一覧',exact=True).click()
        expect(dialog.locator('[data-waiting-status-key]')).to_have_count(2)
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
                if closed_scope=='task':self.page.get_by_role('button',name='完了済みタスクを表示',exact=True).click()
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
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click();self.expand_talks()
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
        self.seed([task(progressEnabled=True,progressStage='doing')]);self.progress();self.select_chat(expand_threads=False)
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click();self.page.get_by_label('小さいタスクの追加',exact=True).check();self.send('まとめる作業',expand_threads=False)
        created=self.stored()[0]['progressHistory'][0];small_id=created['smallTaskId']
        self.page.get_by_role('button',name='まとめる作業のトークを表示',exact=True).click();self.reply(created['id']);self.send('途中の確認記録')
        midway=self.stored()[0]['progressHistory'][-1]
        self.page.get_by_label('結論',exact=True).check();self.send('結論はOK https://example.com/result')
        conclusion=self.stored()[0]['progressHistory'][-1]
        self.page.get_by_role('button',name='まとめる作業を完了',exact=True).click()
        result=self.stored()[0]
        self.assertIn(created,result['progressHistory']);self.assertEqual(len(result['progressHistory']),3)
        expect(self.page.locator('[data-progress-small-task-id="'+small_id+'"]')).to_have_class(re.compile(r'\bbg-blue-50\b'))
        expect(self.entry(midway['id'])).to_be_visible()
        self.select_chat(expand_threads=False)
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
        self.progress();self.select_chat(expand_threads=False);expect(group).to_be_visible()
        self.assertEqual(self.stored()[0]['progressHistory'],result['progressHistory'])

    def test_edit_completion_and_retraction_updates_group_card_and_dependencies(self):
        source=dict(id='origin',kind='comment',createdAt='2026-11-01T01:00:00Z',text='作業A',status='active',addedSmallTask=True,smallTaskId='a',smallTaskTitle='作業A',subtaskIds=['s1'],subtaskTitles=['既存の調査'])
        note=dict(source,id='progress',text='作業の記録',addedSmallTask=False)
        original=task(progressEnabled=True,progressStage='doing',progressHistory=[source,note])
        original['subtasks'][0]['smallTasks']=[dict(id='a',title='作業A'),dict(id='b',title='作業B',dependencies=[dict(kind='small',parentId='s1',id='a',title='作業A')])]
        self.seed([original]);self.progress();self.page.get_by_role('button',name='作業Aのトークを表示',exact=True).click()
        self.entry('progress').get_by_role('button',name='コメントを編集',exact=True).click()
        self.page.get_by_label('結論',exact=True).check();self.page.get_by_label('コメントの編集',exact=True).fill('編集で指定した結論')
        self.page.get_by_role('button',name='編集を保存',exact=True).click()
        self.page.get_by_role('button',name='作業Aを完了',exact=True).click();self.select_chat()
        group=self.page.locator('[data-completed-small-task-id="a"]');expect(group).to_be_visible()
        expect(group.locator('[data-small-task-conclusion]')).to_have_text('編集で指定した結論')
        expect(self.page.locator('[data-progress-small-task-id="b"]')).to_have_class(re.compile(r'\bbg-purple-50\b'))
        group.get_by_role('button',name='結論を編集',exact=True).click()
        self.page.get_by_label('結論',exact=True).uncheck();self.page.get_by_role('button',name='編集を保存',exact=True).click()
        expect(group).to_be_visible();expect(group.locator('[data-small-task-conclusion]')).to_have_count(0)
        self.page.get_by_role('button',name='作業Aのトークを表示',exact=True).click()
        self.page.get_by_role('button',name='作業Aの完了を取り消す',exact=True).click()
        expect(self.page.locator('[data-progress-small-task-id="b"]')).to_have_class(re.compile(r'\bbg-yellow-50\b'))
        self.page.reload();self.progress();self.select_chat();expect(group).to_have_count(0)
        self.assertFalse(self.stored()[0]['subtasks'][0]['smallTasks'][0]['completed'])

    def test_retracting_latest_small_completion_reopens_closed_ancestors(self):
        def record(id,text,status='completed',**extra): return dict(id=id,text=text,kind='comment',createdAt='2026-11-01T01:00:00Z',status=status,smallTaskId='a',smallTaskTitle='作業A',subtaskIds=['s1'],subtaskTitles=['既存の調査'],**extra)
        records=[record('origin','作業A','active',addedSmallTask=True),record('old1','昔の結論'),record('old2','前回の結論'),record('latest','現在の結論')]
        original=task(progressEnabled=True,progressStage='doing',completedAt='2026-11-01T01:00:00Z',progressHistory=records,completedSmallTaskIds=['a'])
        original['completed']=True
        original['subtasks'][0].update(completed=True,completedAt='2026-11-01T01:00:00Z',smallTasks=[dict(id='a',title='作業A',completed=True,completionManaged=True,completionEntryId='latest',completionConclusion=records[-1])])
        self.seed([original]);self.progress();self.page.get_by_role('button',name='完了済みタスクを表示',exact=True).click();self.page.get_by_role('button',name='作業Aのトークを表示',exact=True).click()
        self.entry('old2').get_by_role('button',name='コメントを編集',exact=True).click()
        self.page.get_by_label('コメントの編集',exact=True).fill('過去の結論の本文だけを補足');self.page.get_by_role('button',name='編集を保存',exact=True).click()
        self.assertTrue(self.stored()[0]['subtasks'][0]['smallTasks'][0]['completed'])
        self.page.get_by_role('button',name='作業Aの完了を取り消す',exact=True).click()
        result=self.stored()[0]
        self.assertFalse(result['completed']);self.assertNotIn('completedAt',result)
        self.assertFalse(result['subtasks'][0]['completed']);self.assertFalse(result['subtasks'][0]['smallTasks'][0]['completed'])
        self.assertEqual(next(item for item in result['progressHistory'] if item['id']=='old1')['status'],'completed')
        expect(self.entry('old1').locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))
        expect(self.entry('latest').locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))
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
        self.seed([task(progressEnabled=True,progressStage='doing')]);self.progress();self.select_chat(expand_threads=False)
        self.page.get_by_label('やるべきことの追加',exact=True).check();self.send('成果物を確認',expand_threads=False)
        created=self.stored()[0]['progressHistory'][-1];todo_id=created['subtaskIds'][0]
        self.assertTrue(created['addedSubtask']);self.assertEqual(created['text'],FUTURE+'までに【成果物を確認】')
        group=self.page.locator('[data-todo-thread-id="'+todo_id+'"]')
        expect(group).to_be_visible();expect(self.entry(created['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-purple-50\b'))
        expect(group.get_by_role('button',name='成果物を確認のトークを展開',exact=True)).to_have_attribute('aria-expanded','false')
        self.page.get_by_role('button',name='成果物を確認のトークを表示',exact=True).click();self.send('着手時の記録')
        note=self.stored()[0]['progressHistory'][-1]
        expect(self.entry(note['id'])).to_be_visible()
        expect(group).to_have_count(0)
        self.select_chat(expand_threads=False)
        expect(self.entry(note['id'])).to_have_count(0)
        group.get_by_role('button',name='成果物を確認のトークを展開',exact=True).click();expect(self.entry(note['id'])).to_be_visible()
        self.page.get_by_role('button',name='成果物を確認のトークを表示',exact=True).click()
        self.page.get_by_label('小さいタスクの追加',exact=True).check();self.send('子の照合')
        small=self.stored()[0]['progressHistory'][-1]
        self.page.get_by_role('button',name='子の照合のトークを表示',exact=True).click();self.page.get_by_label('結論',exact=True).check();self.send('子の結論');self.page.get_by_role('button',name='子の照合を完了',exact=True).click()
        self.page.get_by_role('button',name='成果物を確認のトークを表示',exact=True).click()
        nested=self.page.locator('[data-completed-small-task-id="'+small['smallTaskId']+'"]')
        expect(nested).to_be_visible();expect(nested.locator('[data-small-task-conclusion]')).to_have_text('子の結論')
        expect(self.entry(created['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))
        self.page.get_by_role('button',name='成果物を確認を完了',exact=True).click()
        self.assertEqual(len(self.stored()[0]['progressHistory']),4)
        expect(self.entry(created['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))

        expect(self.entry(created['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))
        self.page.reload();self.progress();self.select_chat(expand_threads=False)
        expect(group).to_be_visible();expect(group.get_by_role('button',name='成果物を確認のトークを展開',exact=True)).to_have_attribute('aria-expanded','false')
        self.assertEqual(self.stored()[0]['progressHistory'][0],created)

    def test_completion_reply_adding_next_work_edits_the_original_small_only(self):
        # Legacy replies could finish old work and create new work in one record.
        for next_kind in ['small','todo']:
            with self.subTest(next_kind=next_kind):
                origin=dict(id='original',kind='comment',text='元作業',status='active',addedSmallTask=True,smallTaskId='old',smallTaskTitle='元作業',subtaskIds=['s1'],subtaskTitles=['既存の調査'])
                record=dict(id='legacy-reply',kind='comment',text='次の作業',status='completed',completedSmallTaskId='old',quote=origin,
                    subtaskIds=['s1'] if next_kind=='small' else ['next'],subtaskTitles=['既存の調査'] if next_kind=='small' else ['次の作業'])
                if next_kind=='small': record.update(addedSmallTask=True,smallTaskId='next',smallTaskTitle='次の作業')
                else: record.update(addedSubtask=True)
                original=task(progressEnabled=True,progressStage='doing',progressHistory=[origin,record])
                original['subtasks'][0]['smallTasks']=[dict(id='old',title='元作業',completed=True)]
                if next_kind=='small': original['subtasks'][0]['smallTasks'].append(dict(id='next',title='次の作業',completed=False))
                else: original['subtasks'].append(dict(id='next',title='次の作業',dueDate=FUTURE,completed=False))
                self.seed([original]);self.progress();self.page.get_by_role('button',name='元作業のトークを表示',exact=True).click()
                self.entry('legacy-reply').get_by_role('button',name='コメントを編集',exact=True).click()
                self.page.get_by_label('コメントの編集',exact=True).fill('結論の補足');self.page.get_by_label('結論',exact=True).check()
                self.page.get_by_role('button',name='編集を保存',exact=True).click()
                result=self.stored()[0];next_work=result['subtasks'][0]['smallTasks'][-1] if next_kind=='small' else result['subtasks'][-1]
                self.assertFalse(next_work['completed']);self.assertTrue(result['subtasks'][0]['smallTasks'][0]['completed'])
                self.page.get_by_role('button',name='元作業の完了を取り消す',exact=True).click()
                self.assertFalse(self.stored()[0]['subtasks'][0]['smallTasks'][0]['completed'])
                self.page.reload();self.progress();self.page.get_by_role('button',name='元作業のトークを表示',exact=True).click()
                self.page.get_by_role('button',name='元作業を完了',exact=True).click()
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
        self.seed([original]);self.progress();self.select_chat(expand_threads=False);self.reply('origin');self.page.get_by_label('結論',exact=True).check();self.send('照合の結論',expand_threads=False)
        self.page.get_by_role('button',name='照合のトークを表示',exact=True).click();self.page.get_by_role('button',name='照合を完了',exact=True).click()
        self.select_chat(expand_threads=False)
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
        self.assertEqual(record['text'],'危険なリンク 安全な資料');self.assertNotIn('<',record['text'])
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
        self.page.get_by_role('button',name='復元する作業の完了を取り消す',exact=True).click()
        expect(card).to_have_class(re.compile(r'\bbg-purple-50\b'))
        self.assertFalse(self.stored()[0]['subtasks'][0]['smallTasks'][0]['completed'])
        self.assertEqual(next(entry for entry in self.stored()[0]['progressHistory'] if entry['id']=='latest')['status'],'completed')
        self.page.reload();self.progress();expect(card).to_have_count(1);expect(card).to_have_class(re.compile(r'\bbg-purple-50\b'))
        card.click();self.page.get_by_role('button',name='復元する作業を完了',exact=True).click()
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

    def test_completion_comment_edit_and_delete_retract_canonical_small_and_todo(self):
        for scope in ['small','todo']:
            for action in ['edit','delete']:
                with self.subTest(scope=scope,action=action):
                    original=task(progressEnabled=True,progressStage='doing')
                    if scope=='small':
                        original['subtasks'][0]['smallTasks']=[dict(id='a',title='作業A'),dict(id='b',title='後続作業',dependencies=[dict(kind='small',parentId='s1',id='a',title='作業A')])]
                    else:
                        original['subtasks'][0]['smallTasks']=[dict(id='done-child',title='完了済みの子',completed=True)]
                        original['subtasks'][1]['dependencies']=[dict(kind='subtask',id='s1',title='既存の調査')]
                    record=dict(id='legacy-done',kind='comment',text='従来の完了コメント',status='completed',subtaskIds=['s1'],subtaskTitles=['既存の調査'])
                    if scope=='small':record.update(smallTaskId='a',smallTaskTitle='作業A')
                    else:record.update(completedSubtaskIds=['s1'])
                    original['progressHistory']=[record]
                    if scope=='todo':original['subtasks'][0]['completed']=True
                    self.seed([original]);self.progress()
                    self.page.get_by_role('button',name='作業Aのトークを表示' if scope=='small' else '既存の調査のトークを表示',exact=True).click()
                    result=self.stored()[0];record=result['progressHistory'][-1]
                    target=result['subtasks'][0]['smallTasks'][0] if scope=='small' else result['subtasks'][0]
                    self.assertTrue(target['completed'])
                    card=self.page.locator('[data-progress-small-task-id="a"]' if scope=='small' else '[data-progress-subtask-id="s1"]')
                    expect(card).to_have_class(re.compile(r'\bbg-blue-50\b'))
                    if action=='edit':
                        self.entry(record['id']).get_by_role('button',name='コメントを編集',exact=True).click()
                        self.page.get_by_label('ただのコメント',exact=True).check();self.page.get_by_role('button',name='編集を保存',exact=True).click()
                    else:self.entry(record['id']).get_by_role('button',name='コメントを削除',exact=True).click()
                    expect(card).to_have_class(re.compile(r'\bbg-purple-50\b'))
                    result=self.stored()[0];target=result['subtasks'][0]['smallTasks'][0] if scope=='small' else result['subtasks'][0]
                    self.assertFalse(target['completed'])
                    if scope=='small':self.assertNotIn('a',result.get('completedSmallTaskIds',[]))
                    else:self.assertTrue(result['subtasks'][0]['smallTasks'][0]['completed'])
                    dependent=self.page.locator('[data-progress-small-task-id="b"]' if scope=='small' else '[data-progress-subtask-id="s2"]')
                    expect(dependent).to_have_class(re.compile(r'\bbg-yellow-50\b'))
                    self.page.reload();self.progress();expect(card).to_have_class(re.compile(r'\bbg-purple-50\b'));expect(dependent).to_have_class(re.compile(r'\bbg-yellow-50\b'))
                    self.assertFalse((self.stored()[0]['subtasks'][0]['smallTasks'][0] if scope=='small' else self.stored()[0]['subtasks'][0])['completed'])

    def test_delete_small_completion_clears_closed_ancestors_and_older_flags(self):
        old=dict(id='old-done',kind='comment',text='前回の完了',status='completed',createdAt='2026-11-01T01:00:00Z',subtaskIds=['s1'],subtaskTitles=['既存の調査'],smallTaskId='a',smallTaskTitle='作業A')
        latest=dict(old,id='latest-done',text='最新の完了',createdAt='2026-11-02T01:00:00Z')
        original=task(progressEnabled=True,progressStage='doing',progressHistory=[old,latest],completedSmallTaskIds=['a'])
        original.update(completed=True,completedAt='2026-11-02T01:00:00Z')
        original['subtasks'][0].update(completed=True,completedAt='2026-11-02T01:00:00Z',smallTasks=[dict(id='a',title='作業A',completed=True)])
        original['subtasks'][1]['completed']=True
        self.seed([original]);self.progress();self.page.get_by_role('button',name='作業Aのトークを表示',exact=True).click()
        self.entry('latest-done').get_by_role('button',name='コメントを削除',exact=True).click()
        result=self.stored()[0]
        self.assertFalse(result['completed']);self.assertNotIn('completedAt',result)
        self.assertFalse(result['subtasks'][0]['completed']);self.assertNotIn('completedAt',result['subtasks'][0])
        self.assertFalse(result['subtasks'][0]['smallTasks'][0]['completed']);self.assertTrue(result['subtasks'][1]['completed'])
        expect(self.entry('old-done').locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))
        self.page.reload();self.progress();self.assertFalse(self.stored()[0]['subtasks'][0]['smallTasks'][0]['completed'])
        expect(self.page.locator('[data-progress-small-task-id="a"]')).to_have_class(re.compile(r'\bbg-purple-50\b'))

    def test_deleting_completed_small_creation_message_keeps_the_reopened_card(self):
        record=dict(id='old-completed-origin',kind='comment',text='追加と同時に完了',status='completed',addedSmallTask=True,smallTaskId='a',smallTaskTitle='追加と同時に完了',subtaskIds=['s1'],subtaskTitles=['既存の調査'])
        original=task(progressEnabled=True,progressStage='doing',progressHistory=[record])
        original['subtasks'][0]['smallTasks']=[dict(id='a',title='追加と同時に完了',completed=True)]
        self.seed([original]);self.progress();self.page.get_by_role('button',name='追加と同時に完了のトークを表示',exact=True).click()
        self.entry(record['id']).get_by_role('button',name='コメントを削除',exact=True).click()
        card=self.page.locator('[data-progress-small-task-id="a"]')
        expect(card).to_have_class(re.compile(r'\bbg-purple-50\b'))
        self.assertFalse(self.stored()[0]['subtasks'][0]['smallTasks'][0]['completed'])
        self.page.reload();self.progress();expect(card).to_have_count(1);expect(card).to_have_class(re.compile(r'\bbg-purple-50\b'))

    def test_reply_completion_retraction_targets_original_todo_and_keeps_next_work(self):
        for next_kind in ['todo','small']:
            for action in ['edit','delete']:
                with self.subTest(next_kind=next_kind,action=action):
                    source=dict(id='source',kind='comment',text='元の作業の記録',status='active',subtaskIds=['s1'],subtaskTitles=['既存の調査'])
                    record=dict(id='legacy-next',kind='comment',text='次の作業',status='completed',completedSubtaskIds=['s1'],quote=source,
                        subtaskIds=['next'] if next_kind=='todo' else ['s2'],subtaskTitles=['次の作業'] if next_kind=='todo' else ['期限切れの確認'])
                    if next_kind=='todo':record.update(addedSubtask=True)
                    else:record.update(addedSmallTask=True,smallTaskId='next',smallTaskTitle='次の作業')
                    original=task(progressEnabled=True,progressStage='doing',progressHistory=[source,record]);original['subtasks'][0]['completed']=True
                    if next_kind=='todo':original['subtasks'].append(dict(id='next',title='次の作業',completed=False))
                    else:original['subtasks'][1]['smallTasks']=[dict(id='next',title='次の作業',completed=False)]
                    self.seed([original]);self.progress();self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
                    next_work=self.stored()[0]['subtasks'][-1] if next_kind=='todo' else self.stored()[0]['subtasks'][1]['smallTasks'][0]
                    expect(self.entry(record['id'])).to_be_visible()
                    if action=='edit':
                        self.entry(record['id']).get_by_role('button',name='コメントを編集',exact=True).click()
                        self.page.get_by_label('ただのコメント',exact=True).check();self.page.get_by_role('button',name='編集を保存',exact=True).click()
                    else:self.entry(record['id']).get_by_role('button',name='コメントを削除',exact=True).click()
                    result=self.stored()[0];self.assertFalse(result['subtasks'][0]['completed'])
                    current_next=result['subtasks'][-1] if next_kind=='todo' else result['subtasks'][1]['smallTasks'][0]
                    self.assertEqual(current_next,next_work)
                    self.page.reload();self.progress();self.assertFalse(self.stored()[0]['subtasks'][0]['completed'])

    def test_deleting_small_reply_completion_keeps_new_small_task_pending(self):
        source=dict(id='source',kind='comment',text='元の小さい作業',status='active',subtaskIds=['s1'],subtaskTitles=['既存の調査'],smallTaskId='old',smallTaskTitle='元作業')
        record=dict(source,id='legacy-next',text='次の小さい作業',status='completed',completedSmallTaskId='old',addedSmallTask=True,smallTaskId='new',smallTaskTitle='次の小さい作業',quote=source)
        original=task(progressEnabled=True,progressStage='doing',progressHistory=[source,record])
        original['subtasks'][0]['smallTasks']=[dict(id='old',title='元作業',completed=True),dict(id='new',title='次の小さい作業',completed=False)]
        self.seed([original]);self.progress();self.page.get_by_role('button',name='元作業のトークを表示',exact=True).click()
        self.entry(record['id']).get_by_role('button',name='コメントを削除',exact=True).click()
        result=self.stored()[0];self.assertEqual([small['id'] for small in result['subtasks'][0]['smallTasks']],['old','new'])
        self.assertTrue(all(not small['completed'] for small in result['subtasks'][0]['smallTasks']))
        self.page.reload();self.progress()
        for small_id in ['old','new']:expect(self.page.locator('[data-progress-small-task-id="'+small_id+'"]')).to_have_class(re.compile(r'\bbg-purple-50\b'))

    def test_card_completion_comment_deletion_and_plain_conversion_reopen_todo(self):
        for action in ['delete','plain']:
            with self.subTest(action=action):
                original=task(progressEnabled=True,progressStage='doing',progressHistory=[dict(id='legacy-done',kind='comment',text='以前の完了コメント',status='completed',completedSubtaskIds=['s1'],subtaskIds=['s1'],subtaskTitles=['既存の調査'])])
                original['subtasks'][0].update(completed=True,completedAt='2026-11-01T01:00:00Z')
                self.seed([original]);self.progress()
                result=self.stored()[0];record=result['progressHistory'][-1]
                self.assertTrue(result['subtasks'][0]['completed']);self.assertIn('completedAt',result['subtasks'][0])
                self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
                if action=='delete':self.entry(record['id']).get_by_role('button',name='コメントを削除',exact=True).click()
                else:
                    self.entry(record['id']).get_by_role('button',name='コメントを編集',exact=True).click()
                    self.page.get_by_label('ただのコメント',exact=True).check();self.page.get_by_role('button',name='編集を保存',exact=True).click()
                result=self.stored()[0];self.assertFalse(result['subtasks'][0]['completed']);self.assertNotIn('completedAt',result['subtasks'][0])
                expect(self.page.locator('[data-progress-subtask-id="s1"]')).to_have_class(re.compile(r'\bbg-purple-50\b'))
                with self.page.expect_download() as download:self.page.get_by_role('button',name='エクスポート',exact=True).click()
                backup=Path(download.value.path()).read_bytes();self.seed([])
                self.page.get_by_label('バックアップをインポート',exact=True).set_input_files(dict(name='retracted.json',mimeType='application/json',buffer=backup))
                expect(self.page.get_by_text('データをインポートしました',exact=True)).to_be_visible()
                self.assertFalse(self.stored()[0]['subtasks'][0]['completed'])

    def test_own_small_scope_uses_blue_progress_and_upper_scopes_group_every_state(self):
        self.seed([task(progressEnabled=True,progressStage='doing')]);self.progress()
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
        self.page.get_by_label('小さいタスクの追加',exact=True).check();self.send('階層を確認する作業',expand_threads=False)
        origin=self.stored()[0]['progressHistory'][-1];small_id=origin['smallTaskId']
        card=self.page.locator('[data-progress-small-task-id="'+small_id+'"]')
        expect(card).to_have_class(re.compile(r'\bbg-purple-50\b'))
        group=self.page.locator('[data-small-thread-id="'+small_id+'"]')
        expect(group).to_be_visible();expect(self.entry(origin['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-purple-50\b'))
        self.page.get_by_role('button',name='階層を確認する作業のトークを表示',exact=True).click()
        log=self.page.get_by_role('log',name='進捗履歴')
        expect(group).to_have_count(0);expect(log.locator('[data-todo-thread-id]')).to_have_count(0)
        self.send('実際の進捗',expand_threads=False);progress=self.stored()[0]['progressHistory'][-1]
        expect(self.entry(progress['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))
        expect(self.entry(progress['id']).get_by_text('進捗',exact=True)).to_be_visible()
        self.page.get_by_label('ただのコメント',exact=True).check();self.send('補足メモ',expand_threads=False);note=self.stored()[0]['progressHistory'][-1]
        expect(self.entry(note['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-gray-50\b'))
        expect(log.locator('.bg-purple-50')).to_have_count(0)
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
        expect(log.locator('[data-todo-thread-id]')).to_have_count(0);expect(group).to_be_visible()
        expect(self.entry(progress['id'])).to_have_count(0)
        group.get_by_role('button',name='階層を確認する作業のトークを展開',exact=True).click()
        expect(self.entry(progress['id'])).to_be_visible();expect(group.locator('[data-small-task-conclusion]')).to_have_count(0)
        self.select_chat(expand_threads=False)
        expect(self.page.locator('[data-todo-thread-id="s1"]')).to_be_visible();expect(group).to_be_visible()
        expect(self.entry(origin['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-purple-50\b'))
        self.page.get_by_role('button',name='階層を確認する作業のトークを表示',exact=True).click()
        self.page.get_by_label('結論',exact=True).check();self.send('完了の結論',expand_threads=False);done=self.stored()[0]['progressHistory'][-1]
        self.page.get_by_role('button',name='階層を確認する作業を完了',exact=True).click()
        expect(card).to_have_class(re.compile(r'\bbg-blue-50\b'));expect(log.locator('.bg-purple-50')).to_have_count(0)
        self.select_chat(expand_threads=False)
        expect(group).to_have_attribute('data-completed-small-task-id',small_id)
        expect(self.entry(origin['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))
        expect(group.locator('[data-small-task-conclusion]')).to_have_text('完了の結論')
        self.page.get_by_role('button',name='階層を確認する作業のトークを表示',exact=True).click()
        self.page.get_by_role('button',name='階層を確認する作業の完了を取り消す',exact=True).click()
        expect(card).to_have_class(re.compile(r'\bbg-purple-50\b'));expect(log.locator('.bg-purple-50')).to_have_count(0)
        expect(self.entry(done['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))
        self.select_chat(expand_threads=False);expect(group).to_be_visible()
        expect(group.locator('[data-small-task-conclusion]')).to_have_text('完了の結論')
        expect(self.entry(origin['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-purple-50\b'))

    def test_loading_stale_completion_flags_repairs_cancelled_talks_but_keeps_manual_flags(self):
        origin=dict(id='origin',kind='comment',text='取り消し済みの作業',status='active',createdAt='2026-11-01T01:00:00Z',addedSmallTask=True,smallTaskId='a',smallTaskTitle='取り消し済みの作業',subtaskIds=['s1'],subtaskTitles=['既存の調査'])
        cancelled=dict(origin,id='cancelled',text='完了を取り下げた記録',addedSmallTask=False,plainComment=True,status='note')
        manual=dict(origin,id='manual',text='従来の手動完了項目の補足',addedSmallTask=False,smallTaskId='manual',smallTaskTitle='手動完了',subtaskIds=['s2'],subtaskTitles=['期限切れの確認'])
        original=task(progressEnabled=True,progressStage='doing',progressHistory=[origin,cancelled,manual],completedSmallTaskIds=['a'])
        original['subtasks'][0].update(completed=True,smallTasks=[dict(id='a',title='取り消し済みの作業',completed=True,completionManaged=True)])
        original['subtasks'][1]['smallTasks']=[dict(id='manual',title='手動完了',completed=True)]
        self.seed([original]);self.progress()
        expect(self.page.locator('[data-progress-small-task-id="a"]')).to_have_class(re.compile(r'\bbg-purple-50\b'))
        expect(self.page.locator('[data-progress-small-task-id="manual"]')).to_have_class(re.compile(r'\bbg-blue-50\b'))
        result=self.stored()[0]
        self.assertFalse(result['subtasks'][0]['completed']);self.assertFalse(result['subtasks'][0]['smallTasks'][0]['completed'])
        self.assertNotIn('a',result.get('completedSmallTaskIds',[]));self.assertEqual(result['progressHistory'],original['progressHistory'])
        self.page.reload();self.progress()
        self.assertFalse(self.stored()[0]['subtasks'][0]['smallTasks'][0]['completed'])
        self.assertTrue(self.stored()[0]['subtasks'][1]['smallTasks'][0]['completed'])

    def test_loading_deleted_or_edited_completion_reference_reopens_original_todo(self):
        for deleted in [False,True]:
            with self.subTest(deleted=deleted):
                record=dict(id='done',kind='comment',text='取り下げた完了',status='active',createdAt='2026-11-01T01:00:00Z',subtaskIds=['s1'],subtaskTitles=['既存の調査'],completedSubtaskIds=['s1'])
                original=task(progressEnabled=True,progressStage='doing',progressHistory=[] if deleted else [record])
                original.update(completed=True,completedAt='2026-11-01T01:00:00Z')
                original['subtasks'][0].update(completed=True,completionManaged=True,completionEntryId='done',completedAt='2026-11-01T01:00:00Z')
                self.seed([original]);self.progress();result=self.stored()[0]
                self.assertFalse(result['completed']);self.assertNotIn('completedAt',result)
                self.assertFalse(result['subtasks'][0]['completed']);self.assertNotIn('completionEntryId',result['subtasks'][0])
                expect(self.page.locator('[data-progress-subtask-id="s1"]')).to_have_class(re.compile(r'\bbg-purple-50\b'))
                self.page.reload();self.assertFalse(self.stored()[0]['subtasks'][0]['completed'])

    def test_rich_paste_uses_plain_clipboard_linebreaks_and_preserves_hyperlinks(self):
        html='''<div>\n  <div>\n    <p>1行目<br></p>\n    <p><br></p>\n    <p><a href="https://example.com/spec">仕様書</a><br></p>\n    <p><br></p>\n    <p>最終行</p>\n  </div>\n</div>'''
        for plain in ['1行目\n仕様書\n最終行','1行目\n\n仕様書\n\n最終行']:
            with self.subTest(plain=plain):
                self.seed([task(progressEnabled=True,progressStage='doing')]);self.progress();self.select_chat()
                self.paste_rich_link(html,plain)
                box=self.page.get_by_label('進捗コメント',exact=True)
                self.assertEqual(box.inner_text().replace('\u200b',''),plain)
                expect(box.get_by_role('link',name='仕様書',exact=True)).to_have_attribute('href','https://example.com/spec')
                box.press('Control+Enter');record=self.stored()[0]['progressHistory'][-1]
                self.assertEqual(record['text'],plain)
                self.assertEqual(record['textLinks'],[dict(start=plain.index('仕様書'),end=plain.index('仕様書')+3,url='https://example.com/spec')])

    def test_pasted_url_title_with_formatted_html_does_not_add_blank_lines(self):
        self.seed([task(progressEnabled=True,progressStage='doing')]);self.progress();self.select_chat()
        self.paste_rich_link('''<div>\n  <div>\n    <p>\n      <a href="https://example.com/manual">説明書</a>\n    </p>\n  </div>\n</div>''','https://example.com/manual')
        box=self.page.get_by_label('進捗コメント',exact=True)
        self.assertEqual(box.inner_text().replace('\u200b',''),'説明書')
        expect(box.get_by_role('link',name='説明書',exact=True)).to_have_attribute('href','https://example.com/manual')
        box.press('Control+Enter');self.assertEqual(self.stored()[0]['progressHistory'][-1]['text'],'説明書')

    def test_plain_multiline_paste_keeps_intentional_blank_lines(self):
        self.seed([task(progressEnabled=True,progressStage='doing')]);self.progress();self.select_chat()
        plain='開始\n\nhttps://example.com/spec\n\n終了'
        self.ctx.grant_permissions(['clipboard-read','clipboard-write']);self.page.evaluate('text=>navigator.clipboard.writeText(text)',plain)
        box=self.page.get_by_label('進捗コメント',exact=True);box.press('Control+v')
        self.assertEqual(box.inner_text().replace('\u200b',''),plain)
        box.press('Control+Enter');self.assertEqual(self.stored()[0]['progressHistory'][-1]['text'],plain)

    def test_parent_and_task_colors_follow_actionable_unfinished_children(self):
        variants=[('全員相手待ち',[dict(waiting=True),dict(waiting=True)],'green'),
                  ('相手待ちと進行可能',[dict(waiting=True),dict()],'purple'),
                  ('相手待ちと完了',[dict(waiting=True),dict(completed=True)],'green'),
                  ('全員完了',[dict(completed=True),dict(completed=True)],'purple'),
                  ('内部待ちだけ',[dict(dependencies=[dict(kind='small',parentId='s1',id='missing',title='未完了の関連先')])],'yellow'),
                  ('外部待ちと内部待ち',[dict(waiting=True),dict(dependencies=[dict(kind='small',parentId='s1',id='missing',title='未完了の関連先')])],'green'),
                  ('期限超過だが作業可能',[dict(waiting=True),dict(dueDate=PAST)],'purple'),
                  ('期限超過でも相手待ち',[dict(waiting=True,dueDate=PAST),dict(completed=True)],'green')]
        for name,children,color in variants:
            with self.subTest(name=name):
                original=task(progressEnabled=True,progressStage='doing')
                original['subtasks']=original['subtasks'][:1]
                original['subtasks'][0]['smallTasks']=[dict(id='small'+str(i),title='作業'+str(i),completed=False,**child) if 'completed' not in child else dict(id='small'+str(i),title='作業'+str(i),**child) for i,child in enumerate(children)]
                self.seed([original]);before=self.stored();self.progress();self.select_chat()
                expect(self.card()).to_have_class(re.compile(r'\bbg-'+color+r'-50\b'))
                expect(self.page.locator('[data-progress-subtask-id="s1"]')).to_have_class(re.compile(r'\bbg-'+color+r'-50\b'))
                header=self.page.locator('[data-todo-thread-id="s1"]').locator(':scope > [data-progress-entry-id], :scope > div').first.locator(':scope > div').first
                expect(header).to_have_class(re.compile(r'\bbg-'+color+r'-50\b'))
                self.assertFalse(self.stored()[0]['subtasks'][0].get('waiting',False))
                self.assertFalse(self.stored()[0]['completed']);self.assertEqual(self.stored(),before)

    def test_task_aggregation_excludes_completed_parents_and_keeps_local_waits_and_deadlines(self):
        cases=[('混在',dict(waiting=True),dict(),{},'purple'),
               ('すべて待ち',dict(waiting=True),dict(waiting=True),{},'green'),
               ('完了と待ち',dict(completed=True),dict(waiting=True),{},'green'),
               ('案件自体に待ちがあっても配下で進行可能',dict(),dict(),dict(waiting=True),'purple'),
               ('案件自体の待ちで配下完了',dict(completed=True),dict(completed=True),dict(waiting=True),'green'),
               ('期限は赤を維持',dict(waiting=True),dict(waiting=True),dict(dueDate=PAST),'red')]
        for name,left,right,patch,color in cases:
            with self.subTest(name=name):
                original=task(progressEnabled=True,progressStage='doing');original.update(patch)
                for parent,values in zip(original['subtasks'],[left,right]):parent.update(dueDate=FUTURE,**values)
                self.seed([original]);self.progress();self.select_chat()
                expect(self.card()).to_have_class(re.compile(r'\bbg-'+color+r'-50\b'))
        # An overdue waiting child stays unavailable even though its own card is red.
        original=task(progressEnabled=True,progressStage='doing');original['subtasks']=original['subtasks'][:1]
        original['subtasks'][0].update(waiting=True,dueDate=PAST)
        self.seed([original]);self.progress();self.select_chat()
        expect(self.page.locator('[data-progress-subtask-id="s1"]')).to_have_class(re.compile(r'\bbg-red-50\b'))
        expect(self.card()).to_have_class(re.compile(r'\bbg-green-50\b'))
        expect(self.page.locator('[data-todo-thread-id="s1"]').locator(':scope > div > div').first).to_have_class(re.compile(r'\bbg-red-50\b'))

    def test_aggregate_colors_update_after_wait_resolution_completion_and_retraction(self):
        original=task(progressEnabled=True,progressStage='doing');original['subtasks']=original['subtasks'][:1]
        original['subtasks'][0]['smallTasks']=[dict(id='a',title='作業A',waiting=True),dict(id='b',title='作業B',waiting=True)]
        original['progressHistory']=[dict(id='wait-'+id,kind='comment',text=title+'の返答待ち',status='waiting',subtaskIds=['s1'],subtaskTitles=['既存の調査'],smallTaskId=id,smallTaskTitle=title) for id,title in [('a','作業A'),('b','作業B')]]
        self.seed([original]);self.progress();self.select_chat()
        parent=self.page.locator('[data-progress-subtask-id="s1"]')
        expect(parent).to_have_class(re.compile(r'\bbg-green-50\b'));expect(self.card()).to_have_class(re.compile(r'\bbg-green-50\b'))
        self.page.get_by_role('button',name='作業Bのトークを表示',exact=True).click();self.reply('wait-b');self.send('回答を受領して再開')
        expect(parent).to_have_class(re.compile(r'\bbg-purple-50\b'));expect(self.card()).to_have_class(re.compile(r'\bbg-purple-50\b'))
        self.page.get_by_role('button',name='作業Bを完了',exact=True).click()
        expect(parent).to_have_class(re.compile(r'\bbg-green-50\b'));expect(self.card()).to_have_class(re.compile(r'\bbg-green-50\b'))
        expect(self.page.get_by_role('button',name='既存の調査を完了',exact=True)).to_have_count(0)
        self.page.reload();self.progress();expect(parent).to_have_class(re.compile(r'\bbg-green-50\b'))
        self.select_chat()
        expect(self.page.locator('[data-todo-thread-id="s1"]').locator(':scope > div > div').first).to_have_class(re.compile(r'\bbg-green-50\b'))
        self.page.get_by_role('button',name='作業Aのトークを表示',exact=True).click();self.reply('wait-a');self.send('回答を受けてAを再開')
        expect(parent).to_have_class(re.compile(r'\bbg-purple-50\b'))
        self.page.get_by_role('button',name='作業Aを完了',exact=True).click();done=self.stored()[0]['progressHistory'][-1]
        expect(parent).to_have_class(re.compile(r'\bbg-purple-50\b'))
        expect(self.page.get_by_role('button',name='既存の調査を完了',exact=True)).to_be_visible()
        self.assertFalse(self.stored()[0]['subtasks'][0]['completed'])
        self.page.get_by_role('button',name='作業Aの完了を取り消す',exact=True).click()
        expect(self.page.get_by_role('button',name='既存の調査を完了',exact=True)).to_have_count(0)

    def test_waiting_todo_with_no_small_tasks_has_no_complete_action_until_resolved(self):
        for remove_last in [False,True]:
            with self.subTest(remove_last=remove_last):
                source=dict(id='waiting',kind='comment',text='相手への確認待ち',status='waiting',createdAt='2026-11-01T01:00:00Z',subtaskIds=['s1'],subtaskTitles=['既存の調査'])
                original=task(progressEnabled=True,progressStage='doing',progressHistory=[source]);original['subtasks']=original['subtasks'][:1]
                original['subtasks'][0].update(waiting=True,smallTasks=[dict(id='last',title='最後の小さいタスク')] if remove_last else [])
                self.seed([original]);self.progress()
                if remove_last:
                    expect(self.page.locator('[data-progress-subtask-id="s1"]')).to_have_class(re.compile(r'\bbg-purple-50\b'))
                    self.page.get_by_role('button',name='最後の小さいタスクを削除',exact=True).click()
                parent=self.page.locator('[data-progress-subtask-id="s1"]')
                expect(parent).to_have_class(re.compile(r'\bbg-green-50\b'))
                expect(self.page.get_by_role('button',name='既存の調査を完了',exact=True)).to_have_count(0)
                self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
                expect(self.page.get_by_role('checkbox',name='完了',exact=True)).to_have_count(0)
                self.card().get_by_role('button',name='進捗テスト案件の設定',exact=True).click()
                dialog=self.page.get_by_role('dialog',name='進捗の設定',exact=True)
                expect(dialog.get_by_label('完了',exact=True)).to_be_disabled()
                dialog.get_by_role('button',name='キャンセル',exact=True).click()
                self.reply('waiting');self.send('返信を受領')
                self.assertFalse(self.stored()[0]['subtasks'][0]['waiting']);self.assertFalse(self.stored()[0]['subtasks'][0]['completed'])
                expect(parent).to_have_class(re.compile(r'\bbg-purple-50\b'))
                expect(self.page.get_by_role('button',name='既存の調査を完了',exact=True)).to_be_visible()

    def test_waiting_must_be_cleared_in_editor_before_todo_completion(self):
        source=dict(id='wait',kind='comment',text='回答待ち',status='waiting',createdAt='2026-11-01T01:00:00Z',subtaskIds=['s1'],subtaskTitles=['既存の調査'])
        original=task(progressEnabled=True,progressStage='doing',progressHistory=[source]);original['subtasks']=original['subtasks'][:1]
        original['subtasks'][0]['waiting']=True
        self.seed([original]);self.progress();self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
        self.entry('wait').get_by_role('button',name='コメントを編集',exact=True).click()
        expect(self.page.get_by_role('button',name='既存の調査を完了',exact=True)).to_have_count(0)
        self.page.get_by_label('相手待ち',exact=True).uncheck()
        self.page.get_by_role('button',name='編集を保存',exact=True).click()
        self.page.get_by_role('button',name='既存の調査を完了',exact=True).click()
        result=self.stored()[0];self.assertTrue(result['subtasks'][0]['completed']);self.assertFalse(result['subtasks'][0]['waiting'])
        expect(self.page.locator('[data-progress-subtask-id="s1"]')).to_have_class(re.compile(r'\bbg-blue-50\b'))
        self.assertFalse(result['completed'])

    def test_overdue_cards_and_creation_messages_are_red_but_ordinary_talks_keep_their_meaning(self):
        def record(id,text,status='active',parent='s1',**extra):return dict(id=id,kind='comment',text=text,status=status,createdAt='2026-11-01T01:00:00Z',subtaskIds=[parent] if parent else [],subtaskTitles=['既存の調査'] if parent=='s1' else ['期限切れの確認'] if parent else [],**extra)
        entries=[record('origin','期限までに追加した作業',addedSubtask=True),record('progress','通常の進捗'),record('wait','相手待ちの記録','waiting'),
                 record('plain','補足',plainComment=True),record('root-progress','全体の進捗',parent=None),record('root-wait','全体の相手待ち','waiting',parent=None),
                 record('blocked','関連タスク待ちの記録',parent='s2'),record('blocked-wait','過去の相手待ち','waiting',parent='s2')]
        original=task(progressEnabled=True,progressStage='doing',progressHistory=entries);original['dueDate']=PAST
        for parent in original['subtasks']:parent['dueDate']=PAST
        original['subtasks'][1]['dependencies']=[dict(kind='subtask',id='missing',title='未完了の関連先')]
        self.seed([original]);self.progress();self.select_chat()
        expect(self.card()).to_have_class(re.compile(r'\bbg-red-50\b'))
        expect(self.page.locator('[data-progress-subtask-id="s1"]')).to_have_class(re.compile(r'\bbg-red-50\b'))
        expect(self.page.locator('[data-progress-subtask-id="s2"]')).to_have_class(re.compile(r'\bbg-yellow-50\b'))
        for id,color in [('origin','red'),('progress','blue'),('wait','green'),('plain','gray'),('root-progress','blue'),('root-wait','green'),('blocked','yellow'),('blocked-wait','green')]:
            expect(self.entry(id).locator(':scope > div')).to_have_class(re.compile(r'\bbg-'+color+r'-50\b'))
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
        expect(self.entry('origin').locator(':scope > div')).to_have_class(re.compile(r'\bbg-red-50\b'))
        expect(self.entry('progress').locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))
        expect(self.entry('wait').locator(':scope > div')).to_have_class(re.compile(r'\bbg-green-50\b'))

    def test_overdue_reopened_small_task_keeps_progress_and_quotes_blue_and_waits_green(self):
        def record(id,status='active',**extra):return dict(id=id,kind='comment',text=id,status=status,createdAt='2026-11-01T01:00:00Z',subtaskIds=['s1'],subtaskTitles=['既存の調査'],smallTaskId='a',smallTaskTitle='期限超過の小さい作業',**extra)
        progress=record('progress')
        entries=[record('origin',addedSmallTask=True),progress,record('waiting','waiting'),record('old-done','completed'),record('quote',quote=progress),record('plain',plainComment=True)]
        original=task(progressEnabled=True,progressStage='doing',progressHistory=entries);original['subtasks']=original['subtasks'][:1]
        original['subtasks'][0]['smallTasks']=[dict(id='a',title='期限超過の小さい作業',dueDate=PAST,completed=False,completionManaged=True,waiting=True)]
        self.seed([original]);self.progress();self.page.get_by_role('button',name='期限超過の小さい作業のトークを表示',exact=True).click()
        expect(self.page.locator('[data-progress-small-task-id="a"]')).to_have_class(re.compile(r'\bbg-red-50\b'))
        for id,color in [('origin','red'),('progress','blue'),('waiting','green'),('old-done','blue'),('quote','blue'),('plain','gray')]:
            expect(self.entry(id).locator(':scope > div')).to_have_class(re.compile(r'\bbg-'+color+r'-50\b'))
        expect(self.entry('quote').get_by_role('blockquote')).to_have_class(re.compile(r'\bborder-blue-500\b'))
        self.reply('waiting');self.send('返信を受領し作業を再開')
        expect(self.entry('waiting').locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))
        expect(self.page.locator('[data-progress-small-task-id="a"]')).to_have_class(re.compile(r'\bbg-red-50\b'))

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
        expect(self.page.get_by_text('データをインポートしました',exact=True)).to_be_visible()
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
        button=dialog.get_by_role('button',name='Wordをダウンロード',exact=True)
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
        self.page.get_by_role('button',name='期限切れの確認のトークを表示',exact=True).click();self.expand_talks()
        self.page.get_by_label('履歴を検索',exact=True).fill('検索で表示する返信')
        expect(self.entry(source['id'])).to_have_count(0)
        self.entry(reply['id']).get_by_role('button',name='引用元へ移動: 移動先の元コメント',exact=True).click()
        expect(self.page.get_by_label('履歴を検索',exact=True)).to_have_value('')
        expect(self.page.get_by_label('トークのタイトル',exact=True)).to_have_text('進捗テスト案件')
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
        expect(self.page.locator('[data-progress-subtask-id="s1"]')).to_have_class(re.compile(r'\bbg-purple-50\b'))
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
        expect(self.entry(result['progressHistory'][-1]['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))
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
        expect(self.card()).to_have_class(re.compile(r'\bbg-purple-50\b'))
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
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
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
        expect(self.entry(midway['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))
        expect(self.entry(source['id'])).to_be_visible()
        row.click();self.reply(source['id'])
        self.send('小さい作業が完了しました')
        reply=self.stored()[0]['progressHistory'][-1]
        self.page.get_by_role('button',name='返信で管理する小さい作業を完了',exact=True).click()
        result=self.stored()[0]
        self.assertTrue(result['subtasks'][0]['smallTasks'][0]['completed'])
        self.assertFalse(result['subtasks'][0]['completed'])
        self.assertTrue(result['subtasks'][0]['waiting'])
        self.assertTrue(result['waiting'])
        self.assertTrue(any(item['id']==source['id'] for item in result['progressHistory']))
        self.assertEqual(reply['status'],'active')
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
        self.page.get_by_role('button',name='古い小さい項目を完了',exact=True).click()
        result=self.stored()[0]
        self.assertTrue(result['subtasks'][0]['smallTasks'][0]['completed'])
        self.assertFalse(result['subtasks'][0]['completed'])
        self.assertEqual(result.get('progressHistory',[]),[])
        self.page.reload();self.progress()
        self.page.get_by_role('button',name='古い小さい項目のトークを表示',exact=True).click()
        expect(self.page.get_by_role('log',name='進捗履歴')).not_to_contain_text('Invalid Date')

    def test_task_level_waiting_reply_completion_retains_blue_record_without_completing_task(self):
        source=dict(id='global-complete',kind='comment',text='タスク全体の返答待ち',status='waiting',
                    createdAt='2026-01-01T01:00:00.000Z',subtaskIds=[],subtaskTitles=[])
        original=task(progressEnabled=True,progressStage='doing',waiting=True,progressHistory=[source])
        self.seed([original]);self.progress();self.select_chat()
        row=self.page.locator('[data-progress-waiting-task-id="global-complete"]')
        self.reply(source['id'])
        expect(self.page.get_by_role('checkbox',name='完了',exact=True)).to_have_count(0)
        self.send('返答を受領し完了')
        result=self.stored()[0]
        self.assertFalse(result['waiting'])
        self.assertFalse(result['completed'])
        self.assertEqual(result['subtasks'],original['subtasks'])
        self.assertEqual(len(result['progressHistory']),2)
        reply=result['progressHistory'][-1]
        self.assertEqual(reply['status'],'active')
        self.assertEqual(reply['quote']['text'],source['text'])
        expect(row).to_have_count(0)
        expect(self.entry(source['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))
        self.entry(reply['id']).get_by_role('button',name='コメントを編集',exact=True).click()
        self.page.get_by_label('コメントの編集',exact=True).fill('完了記録の説明を補足')
        self.page.get_by_role('button',name='編集を保存',exact=True).click()
        self.assertEqual(self.stored()[0]['progressHistory'][-1]['status'],'active')

    def test_nonwaiting_comment_is_retained_when_reply_is_completed(self):
        source=dict(id='active-complete',kind='comment',text='完了待ちの進捗記録',status='active',
                    createdAt='2026-01-01T01:00:00.000Z',subtaskIds=['s1'],subtaskTitles=['既存の調査'])
        self.seed([task(progressEnabled=True,progressStage='doing',progressHistory=[source])])
        self.progress();self.select_chat();self.reply(source['id'])
        self.send('進捗を完了にしました')
        result=self.stored()[0]
        self.assertEqual(len(result['progressHistory']),2)
        self.assertFalse(result['subtasks'][0]['completed'])
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
        expect(self.page.locator('[aria-label^="関連:"]')).to_have_count(0)
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
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click();self.expand_talks()
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
        expect(self.entry(message['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))
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
        expect(self.page.get_by_label('やるべきことの追加',exact=True)).to_be_enabled()
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
        expect(self.page.locator('[aria-label^="関連:"]')).to_have_count(0)
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
        expect(self.entry(message['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click();self.expand_talks()
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
        expect(self.entry(message['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))

    def test_reply_to_deleted_todo_keeps_historical_parent_filter(self):
        source=dict(id='deleted-todo-wait',kind='comment',text='削除済みやるべきことの依頼',status='waiting',subtaskIds=['removed-todo'],subtaskTitles=['過去の作業'])
        self.seed([task(progressEnabled=True,progressStage='doing',progressHistory=[source])]);self.progress();self.select_chat();self.reply(source['id'])
        self.send('過去の作業の回答を追記')
        result=self.stored()[0];reply=result['progressHistory'][-1]
        self.assertEqual(reply['subtaskIds'],['removed-todo']);self.assertEqual(reply['subtaskTitles'],['過去の作業'])
        self.assertEqual(reply['quote']['id'],source['id'])
        self.page.get_by_label('履歴を検索',exact=True).fill('過去の作業')
        expect(self.entry(reply['id'])).to_be_visible()
        expect(self.page.get_by_role('button',name='過去の作業のトークを表示',exact=True)).to_have_count(0)

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
        expect(self.entry(final['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))

    def test_nested_small_task_addition_requires_one_todo_and_no_deadline(self):
        original=task(progressEnabled=True,progressStage='doing',waiting=True)
        original['subtasks'][0]['waiting']=True
        self.seed([original]);self.progress();self.select_chat()
        expect(self.page.get_by_label('小さいタスクの追加',exact=True)).to_be_disabled()
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
        self.page.get_by_label('小さいタスクの追加',exact=True).check()
        expect(self.page.get_by_label('追加するやるべきことの期限',exact=True)).to_have_count(0)
        self.send('資料の目次を作成')
        stored=self.stored()[0];small=stored['subtasks'][0]['smallTasks'][0];message=stored['progressHistory'][0]
        self.assertEqual(len(stored['subtasks']),2);self.assertNotIn('dueDate',small);self.assertNotIn('date',small)
        self.assertTrue(stored['waiting']);self.assertTrue(stored['subtasks'][0]['waiting'])
        self.assertEqual(message['subtaskIds'],['s1']);self.assertEqual(message['smallTaskId'],small['id'])
        self.assertEqual(message['smallTaskTitle'],small['title']);self.assertTrue(message['addedSmallTask'])
        self.assertEqual(message['status'],'active');self.assertEqual(message['text'],'資料の目次を作成')
        expect(self.entry(message['id'])).to_contain_text('小さいタスクの追加')
        self.assertEqual(len(stored['progressHistory']),1)

    def test_waiting_small_task_addition_is_green_persists_and_replies_blue(self):
        self.seed([task(progressEnabled=True,progressStage='doing')])
        self.progress();self.select_chat()
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
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
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click();self.expand_talks()
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
        expect(self.entry(reply['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))

    def test_small_task_addition_comment_can_edit_status_without_duplicate_tasks(self):
        self.seed([task(progressEnabled=True,progressStage='doing')])
        self.progress();self.select_chat()
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
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
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
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
        self.select_chat()
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
        expect(self.entry(note['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))
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
        expect(self.page.locator('[aria-label^="関連:"]')).to_have_count(0)
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
        self.send('目次作成を完了')
        reply=self.stored()[0]['progressHistory'][-1]
        self.page.get_by_role('button',name='資料の目次を作成を完了',exact=True).click()
        stored=self.stored()[0]
        self.assertTrue(stored['subtasks'][0]['smallTasks'][0]['completed'])
        self.assertEqual(reply['quote']['id'],message['id'])
        self.assertEqual(reply['quote']['text'],edited['text'])
        self.assertFalse(stored['subtasks'][0]['completed'])
        self.assertFalse(stored['completed'])

    def test_nested_comments_keep_parent_only_filter_and_roundtrip(self):
        original=task(progressEnabled=True,progressStage='doing')
        original['subtasks'][0]['smallTasks']=[dict(id='small1',title='一覧に含めない小さい項目',completed=False)]
        self.seed([original]);self.progress();self.select_chat()
        expect(self.page.get_by_label('関連: 一覧に含めない小さい項目',exact=True)).to_have_count(0)
        expect(self.page.get_by_role('region',name='進捗リストボード',exact=True).get_by_role('combobox')).to_have_count(0)
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
        self.page.locator('[data-progress-small-task-id="small1"]').dblclick()
        self.send('小さい項目についての検討記録')
        message=next(entry for entry in self.stored()[0]['progressHistory'] if entry['kind']=='comment')
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click();self.expand_talks();expect(self.entry(message['id'])).to_be_visible()
        self.page.get_by_role('button',name='期限切れの確認のトークを表示',exact=True).click();expect(self.entry(message['id'])).to_have_count(0)
        self.select_chat()
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
            expect(self.entry(entry['id']).locator(':scope > div')).to_have_class(re.compile(r'\bbg-blue-50\b'))
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
        self.progress();self.select_chat(expand_threads=False)
        self.page.get_by_role('button',name='小さい項目の完了済みトークを展開',exact=True).click()
        expected={'normal':'bg-blue-50','waiting':'bg-green-50','small':'bg-blue-50','small-waiting':'bg-blue-50','small-reply':'bg-blue-50','small-completed':'bg-blue-50','deadline':'bg-blue-50'}
        expect(self.page.locator('[data-progress-entry-id]')).to_have_count(len(expected))
        for key,color in expected.items():
            expect(self.entry(key).locator(':scope > div')).to_have_class(re.compile(r'\b'+color+r'\b'))
        for key in ['empty-reason','no-reason','rename','added','status']:
            expect(self.entry(key)).to_have_count(0)
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click();self.expand_talks()
        expect(self.page.locator('[data-progress-entry-id]')).to_have_count(len(expected))
        self.assertEqual(self.stored()[0]['progressHistory'],entries)
        self.page.reload();self.progress();self.select_chat(expand_threads=False)
        self.page.get_by_role('button',name='小さい項目の完了済みトークを展開',exact=True).click()
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
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
        self.page.locator('[data-progress-small-task-id="small1"]').click()
        self.send('小さい項目の通常進捗')
        small_message=self.stored()[0]['progressHistory'][-1]
        small_box=self.entry(small_message['id']).locator(':scope > div')
        expect(small_box).to_have_class(re.compile(r'\bbg-blue-50\b'))
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
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
        self.page.get_by_label('相手待ち',exact=True).check()
        self.send('最初の担当者への依頼')
        original=next(entry for entry in self.stored()[0]['progressHistory'] if entry['kind']=='comment')
        self.reply(original['id']);self.send('担当者から回答を受領しました')
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
        self.page.get_by_role('button',name='既存の調査を完了',exact=True).click()
        before=self.stored()[0]
        self.entry(original['id']).get_by_role('button',name='コメントを編集',exact=True).click()
        editor=self.page.get_by_label('コメントの編集',exact=True)
        expect(editor).to_have_text('最初の担当者への依頼')
        expect(self.page.locator('[aria-label^="関連:"]')).to_have_count(0)
        expect(self.page.get_by_label('相手待ち',exact=True)).not_to_be_checked()
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
        self.seed([task(progressEnabled=True,progressStage='doing')]);self.progress()
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click();self.send('元の作業へのコメント')
        original=self.stored()[0]['progressHistory'][0]
        self.entry(original['id']).get_by_role('button',name='コメントを編集',exact=True).click()
        self.page.get_by_role('button',name='期限切れの確認のトークを表示',exact=True).click()
        expect(self.page.get_by_label('トークのタイトル',exact=True)).to_have_text('期限切れの確認')
        expect(self.page.get_by_role('status')).to_contain_text('既存の調査')
        self.page.get_by_label('相手待ち',exact=True).check();self.page.get_by_label('コメントの編集',exact=True).fill('元の作業の回答待ちを訂正')
        self.page.get_by_role('button',name='編集を保存',exact=True).click()
        stored=self.stored()[0];edited=stored['progressHistory'][0]
        self.assertEqual(edited['subtaskIds'],['s1']);self.assertEqual(edited['status'],'waiting')
        self.assertTrue(stored['subtasks'][0]['waiting']);self.assertFalse(stored['subtasks'][1].get('waiting',False))
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
        self.entry(original['id']).get_by_role('button',name='コメントを編集',exact=True).click()
        self.page.get_by_label('相手待ち',exact=True).uncheck();self.page.get_by_role('button',name='編集を保存',exact=True).click()
        self.assertFalse(self.stored()[0]['subtasks'][0]['waiting'])
        self.entry(original['id']).get_by_role('button',name='コメントを編集',exact=True).click()
        self.page.get_by_label('やるべきことの追加',exact=True).check();self.page.get_by_label('追加するやるべきことの期限',exact=True).fill(LATER)
        self.page.get_by_label('コメントの編集',exact=True).fill('編集から追加した小タスク');self.page.get_by_role('button',name='編集を保存',exact=True).click()
        stored=self.stored()[0];self.assertEqual(len(stored['subtasks']),3)
        self.assertEqual(stored['subtasks'][-1]['title'],'編集から追加した小タスク');self.assertEqual(stored['subtasks'][-1]['dueDate'],LATER)
        self.assertEqual(len(stored['progressHistory']),1);self.assertTrue(stored['progressHistory'][0]['addedSubtask'])
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
        expect(self.page.get_by_role('checkbox',name='完了',exact=True)).to_have_count(0)
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
        self.page.get_by_label('相手待ち',exact=True).check()
        self.send('担当者に確認を依頼')
        data=self.stored()[0]
        self.assertTrue(data['subtasks'][0]['waiting'])
        self.assertFalse(data.get('waiting',False))
        self.assertIn('bg-purple-50', self.card().get_attribute('class'))
        self.reply(data['progressHistory'][-1]['id']);self.send('担当者から回答を受領')
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
        self.page.get_by_role('button',name='既存の調査を完了',exact=True).click()
        self.assertTrue(self.stored()[0]['subtasks'][0]['completed'])
        self.page.get_by_label('やるべきことの追加',exact=True).check()
        self.send('追加で資料を作成')
        self.assertEqual(self.stored()[0]['subtasks'][-1]['title'],'追加で資料を作成')
        self.assertEqual(self.stored()[0]['subtasks'][-1]['dueDate'],FUTURE)
        self.select_chat()
        self.page.get_by_label('相手待ち',exact=True).check()
        self.send('全体の回答待ち')
        self.assertTrue(self.stored()[0]['waiting'])
        self.assertIn('bg-purple-50',self.card().get_attribute('class'))
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
        expect(self.entry(data['progressHistory'][-1]['id'])).to_be_visible()
        expect(self.page.get_by_text('全体の回答待ち',exact=True)).to_have_count(0)
        self.page.get_by_label('履歴を検索',exact=True).fill('')
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click();self.expand_talks()
        expect(self.entry(data['progressHistory'][-1]['id'])).to_be_visible()
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

    def create_table(self, first='項目', second='担当', body='調査', owner='田中'):
        self.page.get_by_role('button',name='表を作成',exact=True).click()
        dialog=self.page.get_by_role('dialog',name='表を作成',exact=True)
        for label,value in [('1行1列',first),('1行2列',second),('2行1列',body),('2行2列',owner)]:
            dialog.get_by_label(label,exact=True).fill(value)
        dialog.get_by_role('button',name='表を挿入',exact=True).click()

    def test_talk_table_create_edit_send_reload_quote_and_backup(self):
        self.seed([task(progressEnabled=True,progressStage='doing')]);self.progress();self.select_chat()
        box=self.page.get_by_label('進捗コメント',exact=True)
        expect(self.page.get_by_role('button',name='表を編集',exact=True)).to_be_disabled()
        box.fill('打ち合わせ結果');box.press('End')
        self.create_table()
        expect(box.get_by_role('table')).to_be_visible()
        self.page.get_by_role('button',name='表を編集',exact=True).click()
        dialog=self.page.get_by_role('dialog',name='表を編集',exact=True)
        dialog.get_by_label('2行2列',exact=True).fill('佐藤')
        dialog.get_by_role('button',name='表を更新',exact=True).click()
        box.press('Control+Enter')
        source=self.stored()[0]['progressHistory'][-1]
        expect(self.entry(source['id']).get_by_role('table')).to_be_visible()
        expect(self.entry(source['id']).get_by_role('cell',name='佐藤',exact=True)).to_be_visible()
        self.reply(source['id']);self.send('確認しました')
        reply=self.stored()[0]['progressHistory'][-1]
        expect(self.entry(reply['id']).get_by_role('table')).to_be_visible()
        self.entry(source['id']).get_by_role('button',name='コメントを編集',exact=True).click()
        expect(self.page.get_by_label('コメントの編集',exact=True).get_by_role('table')).to_be_visible()
        self.page.get_by_role('button',name='表を編集',exact=True).click()
        dialog=self.page.get_by_role('dialog',name='表を編集',exact=True)
        dialog.get_by_label('2行1列',exact=True).fill('再調査')
        dialog.get_by_role('button',name='表を更新',exact=True).click()
        self.page.get_by_role('button',name='編集を保存',exact=True).click()
        expect(self.entry(source['id']).get_by_role('cell',name='再調査',exact=True)).to_be_visible()
        with self.page.expect_download() as download:self.page.get_by_role('button',name='エクスポート',exact=True).click()
        backup=Path(download.value.path()).read_bytes()
        self.seed([]);self.page.get_by_label('バックアップをインポート',exact=True).set_input_files(dict(name='tables.json',mimeType='application/json',buffer=backup))
        self.progress();self.select_chat()
        expect(self.entry(source['id']).get_by_role('cell',name='再調査',exact=True)).to_be_visible()
        self.page.reload();self.progress();self.select_chat()
        expect(self.entry(source['id']).get_by_role('cell',name='再調査',exact=True)).to_be_visible()
        expect(self.entry(reply['id']).get_by_role('cell',name='調査',exact=True)).to_be_visible()

    def test_talk_table_cancel_resize_multiple_and_plain_text_safety(self):
        self.seed([task(progressEnabled=True,progressStage='doing')]);self.progress();self.select_chat()
        self.create_table(body='A | B',owner='<img src=x onerror=alert(1)>\n<br> & \\path')
        box=self.page.get_by_label('進捗コメント',exact=True)
        expect(box.get_by_role('cell',name='A | B',exact=True)).to_be_visible()
        expect(box.locator('img')).to_have_count(0)
        expect(box.get_by_role('cell',name='<img src=x onerror=alert(1)> <br> & \\path',exact=True)).to_be_visible()
        self.page.get_by_role('button',name='表を編集',exact=True).click()
        dialog=self.page.get_by_role('dialog',name='表を編集',exact=True)
        dialog.get_by_label('表の行数',exact=True).select_option('3')
        dialog.get_by_label('表の列数',exact=True).select_option('3')
        dialog.get_by_label('3行3列',exact=True).fill('未保存')
        dialog.press('Escape')
        expect(box.get_by_role('row')).to_have_count(2)
        self.create_table(first='次の表',body='次の作業')
        expect(box.get_by_role('table')).to_have_count(2)
        self.page.get_by_label('編集する表',exact=True).select_option('1')
        self.page.get_by_role('button',name='表を編集',exact=True).click()
        dialog=self.page.get_by_role('dialog',name='表を編集',exact=True)
        dialog.get_by_label('表の行数',exact=True).select_option('3')
        dialog.get_by_label('3行1列',exact=True).fill('追加行')
        dialog.get_by_role('button',name='表を更新',exact=True).click()
        expect(box.get_by_role('row')).to_have_count(5)
        box.press('Control+Enter')
        source=self.stored()[0]['progressHistory'][-1]
        expect(self.entry(source['id']).get_by_role('table')).to_have_count(2)
        expect(self.entry(source['id']).get_by_role('cell',name='A | B',exact=True)).to_be_visible()
        expect(self.entry(source['id']).locator('img')).to_have_count(0)

    def test_talk_table_boundary_buttons_insert_at_edges_and_between_cells(self):
        self.seed([task(progressEnabled=True,progressStage='doing')]);self.progress();self.select_chat()
        self.page.get_by_role('button',name='表を作成',exact=True).click()
        dialog=self.page.get_by_role('dialog',name='表を作成',exact=True)
        for label,value in [('1行1列','A'),('1行2列','B'),('2行1列','C'),('2行2列','D')]:dialog.get_by_label(label,exact=True).fill(value)
        add=dialog.get_by_role('button',name='2列目の前に列を追加',exact=True)
        self.page.mouse.move(0,0)
        self.assertEqual(add.evaluate('node=>getComputedStyle(node).opacity'),'1')
        add.click()
        expect(dialog.get_by_label('1行3列',exact=True)).to_have_value('B')
        expect(dialog.get_by_label('2行3列',exact=True)).to_have_value('D')
        expect(dialog.get_by_label('2行2列',exact=True)).to_have_value('')
        dialog.get_by_role('button',name='先頭に列を追加',exact=True).click()
        expect(dialog.get_by_label('1行2列',exact=True)).to_have_value('A')
        for _ in range(2):dialog.get_by_role('button',name='末尾に列を追加',exact=True).click()
        expect(dialog.get_by_label('表の列数',exact=True)).to_have_value('6')
        dialog.get_by_role('button',name='2行目の前に行を追加',exact=True).click()
        expect(dialog.get_by_label('3行4列',exact=True)).to_have_value('D')
        expect(dialog.get_by_label('2行4列',exact=True)).to_have_value('')
        dialog.get_by_role('button',name='先頭に行を追加',exact=True).click()
        expect(dialog.get_by_label('2行2列',exact=True)).to_have_value('A')
        for _ in range(2):dialog.get_by_role('button',name='末尾に行を追加',exact=True).click()
        expect(dialog.get_by_label('表の行数',exact=True)).to_have_value('6')
        dialog.get_by_role('button',name='表を挿入',exact=True).click()
        box=self.page.get_by_label('進捗コメント',exact=True)
        expect(box.get_by_role('row')).to_have_count(6)
        self.page.get_by_role('button',name='表を編集',exact=True).click()
        dialog=self.page.get_by_role('dialog',name='表を編集',exact=True)
        expect(dialog.get_by_label('4行4列',exact=True)).to_have_value('D')
        dialog.get_by_role('button',name='2行目の前に行を追加',exact=True).click()
        dialog.get_by_role('button',name='キャンセル',exact=True).click()
        expect(box.get_by_role('row')).to_have_count(6)
        box.press('Control+Enter')
        source=self.stored()[0]['progressHistory'][-1]
        expect(self.entry(source['id']).get_by_role('cell',name='D',exact=True)).to_be_visible()

    def test_talk_table_boundary_button_limits_keyboard_and_touch(self):
        self.seed([task(progressEnabled=True,progressStage='doing')]);self.progress();self.select_chat()
        self.page.get_by_role('button',name='表を作成',exact=True).click()
        dialog=self.page.get_by_role('dialog',name='表を作成',exact=True)
        add=dialog.get_by_role('button',name='末尾に列を追加',exact=True)
        add.focus()
        self.assertEqual(add.evaluate('node=>getComputedStyle(node).opacity'),'1')
        add.press('Enter')
        expect(dialog.get_by_label('表の列数',exact=True)).to_have_value('3')
        dialog.get_by_role('button',name='キャンセル',exact=True).click()
        touch=self.browser.new_context(viewport={'width':390,'height':844},has_touch=True,is_mobile=True)
        try:
            touch.route('https://schedule.test/**',self.route)
            page=touch.new_page();page.goto('https://schedule.test/')
            expect(page.get_by_role('heading',name='TaskMatrix Pro')).to_be_visible(timeout=15000)
            page.evaluate("""() => {
                const host=document.createElement('div');document.body.append(host);
                ReactDOM.createRoot(host).render(React.createElement(ProgressTableDialog,{onApply:()=>{},onClose:()=>{}}));
            }""")
            popup=page.get_by_role('dialog',name='表を作成',exact=True)
            button=popup.get_by_role('button',name='末尾に列を追加',exact=True)
            expect(button).to_be_visible()
            self.assertEqual(button.evaluate('node=>getComputedStyle(node).opacity'),'1')
            button.tap()
            expect(popup.get_by_label('表の列数',exact=True)).to_have_value('3')
        finally:touch.close()

    def paste_grid(self, target, plain='', html=''):
        target.evaluate('''(node, data) => {
            node.focus(); const clipboard=new DataTransfer();
            clipboard.setData('text/plain',data.plain); if(data.html)clipboard.setData('text/html',data.html);
            node.dispatchEvent(new ClipboardEvent('paste',{clipboardData:clipboard,bubbles:true,cancelable:true}));
        }''',dict(plain=plain,html=html))

    def test_excel_paste_expands_dialog_and_preserves_values_and_empty_cells(self):
        self.seed([task(progressEnabled=True,progressStage='doing')]);self.progress();self.select_chat()
        self.create_table();self.page.get_by_role('button',name='表を編集',exact=True).click()
        dialog=self.page.get_by_role('dialog',name='表を編集',exact=True)
        cell=dialog.get_by_label('2行2列',exact=True);cell.click()
        self.paste_grid(cell,'"複数\n行"\t\t"引用""符"\r\n  余白  \tB\tC\r\n')
        expect(dialog.get_by_label('表の行数',exact=True)).to_have_value('3')
        expect(dialog.get_by_label('表の列数',exact=True)).to_have_value('4')
        expect(dialog.get_by_label('2行2列',exact=True)).to_have_value('複数\n行')
        expect(dialog.get_by_label('2行3列',exact=True)).to_have_value('')
        expect(dialog.get_by_label('2行4列',exact=True)).to_have_value('引用"符')
        expect(dialog.get_by_label('3行2列',exact=True)).to_have_value('  余白  ')
        expect(dialog.get_by_label('1行1列',exact=True)).to_have_value('項目')
        dialog.get_by_role('button',name='表を更新',exact=True).click()
        self.page.get_by_role('button',name='表を編集',exact=True).click()
        dialog=self.page.get_by_role('dialog',name='表を編集',exact=True)
        expect(dialog.get_by_label('3行2列',exact=True)).to_have_value('  余白  ')
        large='\r\n'.join('\t'.join(f'{i}:{j}' for j in range(11)) for i in range(21))
        cell=dialog.get_by_label('1行1列',exact=True);cell.click();self.paste_grid(cell,large)
        expect(dialog.get_by_label('表の行数',exact=True)).to_have_value('21')
        expect(dialog.get_by_label('表の列数',exact=True)).to_have_value('11')
        expect(dialog.get_by_label('21行11列',exact=True)).to_have_value('20:10')
        dialog.get_by_role('button',name='表を更新',exact=True).click()
        box=self.page.get_by_label('進捗コメント',exact=True);box.press('Control+Enter')
        source=self.stored()[0]['progressHistory'][-1]
        expect(self.entry(source['id']).get_by_role('cell',name='20:10',exact=True)).to_be_visible()

    def test_excel_html_direct_paste_merges_safety_and_oversize_rejection(self):
        self.seed([task(progressEnabled=True,progressStage='doing')]);self.progress();self.select_chat()
        box=self.page.get_by_label('進捗コメント',exact=True)
        html='<html><body><!--StartFragment--><table><tr><td rowspan="2">担当</td><td colspan="2">案件</td></tr><tr><td>001<br>改行</td><td><script>window.excelPasteExecuted=true</script><img src="x" onerror="window.excelPasteExecuted=true">&lt;安全&gt;</td></tr></table><!--EndFragment--></body></html>'
        self.paste_grid(box,'担当\t案件\t\r\n\t001\n改行\t<安全>',html)
        expect(box.get_by_role('table')).to_have_count(1)
        self.assertFalse(self.page.evaluate('!!window.excelPasteExecuted'))
        expect(box.locator('img,script')).to_have_count(0)
        self.page.get_by_role('button',name='表を編集',exact=True).click()
        dialog=self.page.get_by_role('dialog',name='表を編集',exact=True)
        expect(dialog.get_by_label('2行2列',exact=True)).to_have_value('001\n改行')
        expect(dialog.get_by_label('1行3列',exact=True)).to_have_value('')
        cell=dialog.get_by_label('2行2列',exact=True);cell.click()
        self.paste_grid(cell,'\t'.join('x' for _ in range(101)))
        expect(dialog.get_by_role('alert')).to_contain_text('範囲を分けて')
        expect(cell).to_have_value('001\n改行')
        expect(dialog.get_by_label('表の列数',exact=True)).to_have_value('3')
        dialog.get_by_role('button',name='キャンセル',exact=True).click()
        box.press('Control+Enter');source=self.stored()[0]['progressHistory'][-1]
        expect(self.entry(source['id']).get_by_role('cell',name='<安全>',exact=True)).to_be_visible()

    def test_grid_drag_copy_clear_and_delete_rows_columns(self):
        self.seed([task(progressEnabled=True,progressStage='doing')]);self.progress();self.select_chat()
        self.page.get_by_role('button',name='表を作成',exact=True).click()
        dialog=self.page.get_by_role('dialog',name='表を作成',exact=True)
        cell=dialog.get_by_label('1行1列',exact=True);cell.click()
        self.paste_grid(cell,'A\tB\tC\r\nD\tE\tF\r\nG\tH\tI')
        def drag(start,end):
            a=dialog.get_by_label(start,exact=True).bounding_box();b=dialog.get_by_label(end,exact=True).bounding_box()
            self.page.mouse.move(a['x']+a['width']/2,a['y']+a['height']/2);self.page.mouse.down()
            self.page.mouse.move(b['x']+b['width']/2,b['y']+b['height']/2,steps=8);self.page.mouse.up()
        drag('1行1列','2行2列')
        self.ctx.grant_permissions(['clipboard-read','clipboard-write'])
        dialog.get_by_role('button',name='選択セルをコピー',exact=True).click()
        expect(dialog.get_by_role('status')).to_contain_text('コピーしました')
        self.assertEqual(self.page.evaluate('navigator.clipboard.readText()'),'A\tB\r\nD\tE')
        dialog.get_by_role('button',name='選択セルの内容を削除',exact=True).click()
        for label in ['1行1列','1行2列','2行1列','2行2列']:expect(dialog.get_by_label(label,exact=True)).to_have_value('')
        expect(dialog.get_by_label('2行3列',exact=True)).to_have_value('F')
        dialog.get_by_role('button',name='選択行を削除',exact=True).click()
        expect(dialog.get_by_label('表の行数',exact=True)).to_have_value('1')
        expect(dialog.get_by_label('1行1列',exact=True)).to_have_value('G')
        drag('1行1列','1行2列')
        dialog.get_by_role('button',name='選択列を削除',exact=True).click()
        expect(dialog.get_by_label('表の列数',exact=True)).to_have_value('1')
        expect(dialog.get_by_label('1行1列',exact=True)).to_have_value('I')
        dialog.get_by_role('button',name='選択行を削除',exact=True).click()
        expect(dialog.get_by_label('1行1列',exact=True)).to_have_value('')
        dialog.get_by_label('1行1列',exact=True).fill('最後のセル')
        dialog.get_by_role('button',name='表を挿入',exact=True).click()
        box=self.page.get_by_label('進捗コメント',exact=True);box.press('Control+Enter')
        source=self.stored()[0]['progressHistory'][-1]
        expect(self.entry(source['id']).get_by_role('columnheader',name='最後のセル',exact=True)).to_be_visible()

    def test_grid_keyboard_range_copy_delete_and_cancel(self):
        self.seed([task(progressEnabled=True,progressStage='doing')]);self.progress();self.select_chat()
        self.create_table();self.page.get_by_role('button',name='表を編集',exact=True).click()
        dialog=self.page.get_by_role('dialog',name='表を編集',exact=True)
        cell=dialog.get_by_label('1行1列',exact=True);cell.click();cell.press('Shift+ArrowRight');cell.press('Shift+ArrowDown')
        copied=cell.evaluate('''node=>{const data=new DataTransfer();node.dispatchEvent(new ClipboardEvent('copy',{clipboardData:data,bubbles:true,cancelable:true}));return data.getData('text/plain')}''')
        self.assertEqual(copied,'項目\t担当\r\n調査\t田中')
        cell.press('Delete')
        expect(dialog.get_by_label('2行2列',exact=True)).to_have_value('')
        dialog.get_by_role('button',name='キャンセル',exact=True).click()
        self.page.get_by_role('button',name='表を編集',exact=True).click()
        dialog=self.page.get_by_role('dialog',name='表を編集',exact=True)
        expect(dialog.get_by_label('2行2列',exact=True)).to_have_value('田中')

    def test_grid_native_clipboard_roundtrip_and_single_cell_paste(self):
        self.seed([task(progressEnabled=True,progressStage='doing')]);self.progress();self.select_chat()
        self.create_table();self.page.get_by_role('button',name='表を編集',exact=True).click()
        dialog=self.page.get_by_role('dialog',name='表を編集',exact=True)
        cell=dialog.get_by_label('1行1列',exact=True);cell.click();cell.press('Shift+ArrowRight');cell.press('Shift+ArrowDown')
        self.ctx.grant_permissions(['clipboard-read','clipboard-write'])
        dialog.get_by_role('button',name='選択セルをコピー',exact=True).click()
        expect(dialog.get_by_role('status')).to_contain_text('コピーしました')
        target=dialog.get_by_label('2行2列',exact=True);target.click();target.press('Control+V')
        expect(dialog.get_by_label('表の行数',exact=True)).to_have_value('3')
        expect(dialog.get_by_label('表の列数',exact=True)).to_have_value('3')
        expect(dialog.get_by_label('3行3列',exact=True)).to_have_value('田中')
        self.page.evaluate("navigator.clipboard.writeText('差し替え')")
        target.click();target.press('Control+V')
        expect(target).to_have_value('差し替え')
        self.page.evaluate('value => navigator.clipboard.writeText(value)', '"引用""符"')
        target.click();target.press('Control+V')
        expect(target).to_have_value('引用"符')
        self.page.evaluate("navigator.clipboard.writeText('差し替え')")
        target.click();target.press('Control+V')
        target.dblclick();target.press('End');target.press_sequentially('追記')
        expect(target).to_have_value('差し替え追記')
        target.press('Escape');target.press('Delete')
        expect(target).to_have_value('')

    def test_grid_four_edges_have_always_visible_add_and_remove_buttons(self):
        self.seed([task(progressEnabled=True,progressStage='doing')]);self.progress();self.select_chat()
        self.create_table();self.page.get_by_role('button',name='表を編集',exact=True).click()
        dialog=self.page.get_by_role('dialog',name='表を編集',exact=True)
        self.page.mouse.move(0,0)
        for side in ['top','bottom','left','right']:
            buttons=dialog.locator(f'[data-grid-side="{side}"]')
            expect(buttons).to_have_count(5)
            for button in buttons.all():self.assertEqual(button.evaluate('node=>getComputedStyle(node).opacity'),'1')
        dialog.get_by_role('button',name='2列目の前に列を追加',exact=True).click()
        expect(dialog.get_by_label('1行3列',exact=True)).to_have_value('担当')
        dialog.get_by_role('button',name='2列目を削除（下辺）',exact=True).click()
        expect(dialog.get_by_label('1行2列',exact=True)).to_have_value('担当')
        dialog.get_by_role('button',name='末尾に行を追加（右辺）',exact=True).click()
        expect(dialog.get_by_label('表の行数',exact=True)).to_have_value('3')
        dialog.get_by_role('button',name='3行目を削除（左辺）',exact=True).click()
        expect(dialog.get_by_label('表の行数',exact=True)).to_have_value('2')
        dialog.get_by_role('button',name='末尾に列を追加（下辺）',exact=True).click()
        dialog.get_by_role('button',name='3列目を削除（上辺）',exact=True).click()
        dialog.get_by_role('button',name='先頭に行を追加',exact=True).click()
        dialog.get_by_role('button',name='1行目を削除（右辺）',exact=True).click()
        expect(dialog.get_by_label('1行1列',exact=True)).to_have_value('項目')
        self.page.screenshot(path='/tmp/schedule-four-edges.png')

    def test_grid_context_menu_preserves_drag_selection_and_keyboard_shortcuts(self):
        self.seed([task(progressEnabled=True,progressStage='doing')]);self.progress();self.select_chat()
        self.create_table();self.page.get_by_role('button',name='表を編集',exact=True).click()
        dialog=self.page.get_by_role('dialog',name='表を編集',exact=True)
        first=dialog.get_by_label('1行1列',exact=True);last=dialog.get_by_label('2行2列',exact=True)
        a=first.bounding_box();b=last.bounding_box()
        self.page.mouse.move(a['x']+20,a['y']+20);self.page.mouse.down();self.page.mouse.move(b['x']+20,b['y']+20,steps=8);self.page.mouse.up()
        last.click(button='right')
        menu=dialog.get_by_role('menu',name='表の選択範囲の操作',exact=True)
        expect(menu.get_by_role('menuitem')).to_have_count(4)
        self.page.screenshot(path='/tmp/schedule-grid-context.png')
        self.ctx.grant_permissions(['clipboard-read','clipboard-write'])
        menu.get_by_role('menuitem',name=re.compile('^コピー')).click()
        expect(dialog.get_by_role('status')).to_contain_text('コピーしました')
        self.assertEqual(self.page.evaluate('navigator.clipboard.readText()'),'項目\t担当\r\n調査\t田中')
        last.click(button='right');menu.get_by_role('menuitem',name=re.compile('^セル内容削除')).click()
        expect(first).to_have_value('');expect(last).to_have_value('')
        self.page.keyboard.press('Control+z')
        expect(first).to_have_value('項目');expect(last).to_have_value('田中')
        first.click();first.press('Shift+F10');expect(menu).to_be_visible()
        self.page.keyboard.press('Escape');expect(menu).to_have_count(0);expect(dialog).to_be_visible()
        first.press('Control+Alt+Backspace')
        expect(dialog.get_by_label('表の行数',exact=True)).to_have_value('1')
        expect(first).to_have_value('調査')
        self.page.keyboard.press('Control+z')
        expect(dialog.get_by_label('表の行数',exact=True)).to_have_value('2')
        first.press('Control+Shift+Backspace')
        expect(dialog.get_by_label('表の列数',exact=True)).to_have_value('1')
        expect(first).to_have_value('担当')
        self.page.keyboard.press('Control+z');expect(dialog.get_by_label('表の列数',exact=True)).to_have_value('2')

    def test_grid_undo_redo_tracks_paste_structure_text_and_new_branch(self):
        self.seed([task(progressEnabled=True,progressStage='doing')]);self.progress();self.select_chat()
        self.create_table();self.page.get_by_role('button',name='表を編集',exact=True).click()
        dialog=self.page.get_by_role('dialog',name='表を編集',exact=True)
        cell=dialog.get_by_label('1行1列',exact=True);cell.click();self.paste_grid(cell,'A\tB\tC\nD\tE\tF\nG\tH\tI')
        dialog.get_by_role('button',name='3行目を削除（右辺）',exact=True).click()
        expect(dialog.get_by_label('表の行数',exact=True)).to_have_value('2')
        self.page.keyboard.press('Control+z');expect(dialog.get_by_label('3行3列',exact=True)).to_have_value('I')
        self.page.keyboard.press('Control+z');expect(cell).to_have_value('項目')
        expect(dialog.get_by_label('表の列数',exact=True)).to_have_value('2')
        self.page.keyboard.press('Control+y');expect(cell).to_have_value('A')
        self.page.keyboard.press('Control+Shift+z');expect(dialog.get_by_label('表の行数',exact=True)).to_have_value('2')
        self.page.keyboard.press('Control+z');expect(dialog.get_by_label('表の行数',exact=True)).to_have_value('3')
        cell.fill('別の変更');expect(dialog.get_by_role('button',name='表の操作をやり直す',exact=True)).to_be_disabled()
        cell.press('Control+z');expect(cell).to_have_value('A')
        cell.press('Control+y');expect(cell).to_have_value('別の変更')
        dialog.get_by_role('button',name='表を更新',exact=True).click()
        self.page.get_by_label('進捗コメント',exact=True).press('Control+Enter')
        source=self.stored()[0]['progressHistory'][-1]
        expect(self.entry(source['id']).get_by_role('columnheader',name='別の変更',exact=True)).to_be_visible()

    def test_progress_task_tiles_two_columns_colors_home_and_draft(self):
        fixtures=[]
        for i,state in enumerate(['active','waiting','overdue','completed']):
            item=task(id='tile'+str(i),progressEnabled=True,progressStage='doing');item.update(title='タスク'+str(i),subtasks=[],dueDate=PAST if state=='overdue' else FUTURE,waiting=state=='waiting',completed=state=='completed')
            fixtures.append(item)
        self.seed(fixtures);self.progress(home=True)
        tiles=self.page.get_by_label('大タスクのタイル',exact=True)
        expect(tiles.locator('[data-progress-task-id]')).to_have_count(3)
        self.assertEqual(len(tiles.evaluate('node=>getComputedStyle(node).gridTemplateColumns.split(" ")')),2)
        for i,state in enumerate(['active','waiting','overdue']):
            tile=self.card('tile'+str(i));expect(tile).to_have_attribute('data-status',state)
            expect(tile.get_by_role('button')).to_have_count(1)
            expect(tile).to_have_text('タスク'+str(i)+'期限: '+(PAST if state=='overdue' else FUTURE))
        self.card('tile0').get_by_role('button',name='タスク0',exact=True).click()
        expect(tiles).to_have_count(0)
        expect(self.card('tile0').get_by_role('button',name='タスク0の設定',exact=True)).to_be_visible()
        box=self.page.get_by_label('進捗コメント',exact=True);box.fill('ホームに戻っても保持')
        self.page.get_by_role('button',name='大タスクのホーム',exact=True).click()
        expect(tiles).to_be_visible();expect(box).to_have_text('ホームに戻っても保持')
        self.card('tile0').get_by_role('button',name='タスク0',exact=True).click()
        expect(box).to_have_text('ホームに戻っても保持')
        self.page.get_by_role('button',name='大タスクのホーム',exact=True).click()
        self.card('tile1').get_by_role('button',name='タスク1',exact=True).click()
        expect(self.page.get_by_label('トークのタイトル',exact=True)).to_have_text('タスク1')
        self.page.get_by_role('button',name='大タスクのホーム',exact=True).click()
        self.page.get_by_role('button',name='完了済みタスクを表示',exact=True).click()
        expect(self.card('tile3')).to_have_attribute('data-status','completed')
        expect(tiles.locator('[data-progress-task-id]')).to_have_count(1)

    def test_hide_todo_expands_composer_and_persists_without_changing_tasks(self):
        self.seed([task(progressEnabled=True,progressStage='doing'),task(id='todo',progressEnabled=True,progressStage='todo')]);self.progress();self.select_chat()
        before=self.stored();box=self.page.get_by_label('進捗コメント',exact=True);box.fill('広い入力欄')
        height=box.bounding_box()['height']
        self.page.get_by_role('button',name='未着手ボードを非表示',exact=True).click()
        expect(self.page.get_by_role('region',name='未着手ボード',exact=True)).to_have_count(0)
        history=self.page.get_by_role('region',name='トーク履歴ボード',exact=True).bounding_box()
        form=self.page.get_by_role('form',name='トーク送信',exact=True).bounding_box()
        self.assertGreaterEqual(form['x'],history['x']+history['width'])
        self.assertAlmostEqual(form['y'],history['y'],delta=2)
        self.assertAlmostEqual(form['height'],history['height'],delta=2)
        self.assertGreater(box.bounding_box()['height'],height*3)
        expect(box).to_have_text('広い入力欄');self.assertEqual(self.stored(),before)
        self.page.screenshot(path='/tmp/schedule-expanded-talk.png')
        self.page.reload();self.progress();self.select_chat()
        expect(self.page.get_by_role('region',name='未着手ボード',exact=True)).to_have_count(0)
        self.page.get_by_role('button',name='未着手ボードを表示',exact=True).click()
        expect(self.card('todo')).to_be_visible()

    def test_side_composer_sends_replies_edits_and_tables_without_losing_drafts(self):
        self.seed([task(progressEnabled=True,progressStage='doing')]);self.progress();self.select_chat()
        self.page.get_by_role('button',name='未着手ボードを非表示',exact=True).click()
        self.send('横並びから送信')
        source=self.stored()[0]['progressHistory'][-1]
        self.reply(source['id']);self.send('返信も右の入力欄から')
        reply=self.stored()[0]['progressHistory'][-1]
        self.assertEqual(reply['quote']['id'],source['id'])
        self.entry(reply['id']).get_by_role('button',name='コメントを編集',exact=True).click()
        editor=self.page.get_by_label('コメントの編集',exact=True);editor.fill('切り替えても編集を保持')
        self.page.get_by_role('button',name='未着手ボードを表示',exact=True).click()
        expect(editor).to_have_text('切り替えても編集を保持')
        self.page.get_by_role('button',name='未着手ボードを非表示',exact=True).click()
        expect(editor).to_have_text('切り替えても編集を保持')
        editor.press('Control+Enter')
        expect(self.entry(reply['id'])).to_contain_text('切り替えても編集を保持')
        self.create_table()
        self.page.get_by_label('進捗コメント',exact=True).press('Control+Enter')
        table=self.stored()[0]['progressHistory'][-1]
        expect(self.entry(table['id']).get_by_role('table')).to_be_visible()
        expect(self.page.get_by_role('heading',name='コメント入力',exact=True)).to_be_visible()

if __name__=='__main__':unittest.main(verbosity=2)
