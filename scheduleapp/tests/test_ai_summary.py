"""AI handoff/summary browser regressions: python3 scheduleapp/tests/test_ai_summary.py."""
import base64
import io
import json
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET
import zipfile
import test_progress as base
from playwright.sync_api import expect


class AISummaryTests(base.ProgressTests):
    def open_task(self):
        self.page.get_by_label('大タスクのタイル',exact=True).get_by_role('button',name='進捗テスト案件',exact=True).click()

    def input_summary(self):
        self.page.get_by_role('button',name='AI要約を入力',exact=True).click()
        editor=self.page.get_by_role('textbox',name='AI要約の入力欄',exact=True)
        expect(editor).to_be_empty()
        return editor

    def paste(self, editor, plain, html=None):
        self.ctx.grant_permissions(['clipboard-read','clipboard-write'])
        if html:
            self.page.evaluate('''async ({html,plain})=>navigator.clipboard.write([new ClipboardItem({'text/html':new Blob([html],{type:'text/html'}),'text/plain':new Blob([plain],{type:'text/plain'})})])''',dict(html=html,plain=plain))
        else:self.page.evaluate('text=>navigator.clipboard.writeText(text)',plain)
        editor.click();editor.press('Control+V')

    def save(self):
        self.page.get_by_role('button',name='要約を保存',exact=True).click()
        expect(self.page.get_by_role('dialog',name='AI要約入力',exact=True)).to_have_count(0)

    def show(self):
        self.page.get_by_role('button',name='AI要約',exact=True).click()
        return self.page.get_by_role('region',name='AI要約の表示',exact=True)

    def test_markdown_paste_latest_blank_replacement_and_reload(self):
        self.seed([base.task(progressEnabled=True,progressStage='doing')]);self.open_task()
        viewer=self.show();expect(viewer).to_contain_text('要約内容はまだありません')
        expect(viewer.get_by_role('button',name='AI要約用Wordを出力',exact=True)).to_be_visible()
        editor=self.input_summary()
        image='data:image/png;base64,'+base64.b64encode(self.progress_png()).decode()
        value='# 現状のまとめ\n\n**重要な結論**\n\n- 決定したこと\n  - 次の行動\n\n| 担当 | 期限 |\n| --- | --- |\n| 田中 | 明日 |\n\n[仕様書](https://example.com/spec)\n\n![添付結果]('+image+')'
        self.paste(editor,value)
        expect(editor.get_by_role('heading',name='現状のまとめ',exact=True)).to_be_visible()
        expect(editor.locator('strong')).to_have_text('重要な結論')
        expect(editor.locator('ul ul')).to_have_count(1)
        expect(editor.locator('table')).to_have_count(1)
        expect(editor.get_by_role('img',name='添付結果',exact=True)).to_be_visible()
        self.save()
        self.page.get_by_role('button',name='最新の要約結果を表示',exact=True).click()
        expect(viewer.get_by_role('heading',name='現状のまとめ',exact=True)).to_be_visible()
        expect(viewer.get_by_role('link',name='仕様書',exact=True)).to_have_attribute('href','https://example.com/spec')
        expect(viewer.locator('table')).to_contain_text('田中')
        editor=self.input_summary()
        self.paste(editor,'## 更新した要約\n\n最新の結論のみ')
        self.save();expect(viewer).to_contain_text('最新の結論のみ');expect(viewer).not_to_contain_text('重要な結論')
        self.page.reload();self.open_task();viewer=self.show();expect(viewer).to_contain_text('最新の結論のみ')
        editor=self.input_summary();self.page.get_by_role('button',name='キャンセル',exact=True).click()
        expect(viewer).to_contain_text('最新の結論のみ')
        self.page.screenshot(path='/tmp/schedule-ai-summary.png')

    def test_summary_scope_isolation_other_card_and_checkbox(self):
        original=base.task(progressEnabled=True,progressStage='doing');original['subtasks'][0]['smallTasks']=[dict(id='tiny',title='検証作業')]
        self.seed([original]);self.open_task()
        todos=self.page.get_by_role('region',name='やるべきことボード',exact=True)
        expect(todos.get_by_role('button',name='その他のトークを表示',exact=True)).to_be_visible()
        editor=self.input_summary();self.paste(editor,'# 大タスク全体の要約');self.save()
        todos.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
        expect(self.show()).to_contain_text('要約内容はまだありません')
        editor=self.input_summary();self.paste(editor,'# 調査だけの要約');self.save()
        todos.get_by_role('button',name='検証作業のトークを表示',exact=True).click()
        expect(self.show()).to_contain_text('要約内容はまだありません')
        editor=self.input_summary();self.paste(editor,'# 小作業だけの要約');self.save()
        todos.get_by_role('button',name='その他のトークを表示',exact=True).click()
        expect(self.show()).to_contain_text('要約内容はまだありません')
        self.open_task();expect(self.show()).to_contain_text('大タスク全体の要約')
        compact=self.page.get_by_role('checkbox',name='コンパクト表示',exact=True)
        compact.check();expect(compact).to_be_checked();expect(self.show()).to_contain_text('大タスク全体の要約')
        with self.page.expect_download() as download:self.page.get_by_role('button',name='エクスポート',exact=True).click()
        data=json.loads(Path(download.value.path()).read_text())
        self.assertEqual(len(data['tasks'][0]['aiSummaries']),3)
        self.seed([])
        self.page.get_by_label('バックアップをインポート',exact=True).set_input_files(dict(name='summary.json',mimeType='application/json',buffer=json.dumps(data).encode()))
        self.open_task();expect(self.show()).to_contain_text('大タスク全体の要約')

    def test_word_prompt_scoped_source_embedded_images_table_links_and_filters(self):
        original=base.task(progressEnabled=True,progressStage='doing')
        original['subtasks'][1]['progressHidden']=True
        original['progressHistory']=[dict(id='source',kind='comment',status='active',text='検証した結果\n\n| 項目 | 値 |\n| --- | --- |\n| 電圧 | 12V |',subtaskIds=['s1'],subtaskTitles=['既存の調査'],images=[dict(name='結果画像.png',src='data:image/png;base64,'+base64.b64encode(self.progress_png()).decode())],links=[dict(label='仕様リンク',url='https://example.com/spec')]),dict(id='root',kind='comment',status='active',text='範囲外の全体会話',subtaskIds=[]),dict(id='hidden',kind='comment',status='active',text='非表示の秘密の会話',subtaskIds=['s2'])]
        self.seed([original]);self.open_task()
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
        with self.page.expect_download() as download:self.page.get_by_role('button',name='AI要約用Wordを出力',exact=True).click()
        with zipfile.ZipFile(io.BytesIO(Path(download.value.path()).read_bytes())) as archive:
            root=ET.fromstring(archive.read('word/document.xml'));ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
            text='\n'.join(node.text or '' for node in root.findall('.//w:t',ns))
            for value in ['Markdown形式','画像・表・URLを効果的に','検証した結果','12V','結果画像.png','仕様リンク']:self.assertIn(value,text)
            for value in ['範囲外の全体会話','非表示の秘密の会話']:self.assertNotIn(value,text)
            self.assertEqual(len(root.findall('.//w:tbl',ns)),1)
            self.assertTrue(any(name.startswith('word/media/') for name in archive.namelist()))
            self.assertIn('https://example.com/spec',archive.read('word/_rels/document.xml.rels').decode())
        self.page.get_by_label('履歴を検索',exact=True).fill('一致しない言葉')
        with self.page.expect_download() as download:self.page.get_by_role('button',name='AI要約用Wordを出力',exact=True).click()
        with zipfile.ZipFile(Path(download.value.path())) as archive:
            text=archive.read('word/document.xml').decode();self.assertNotIn('検証した結果',text);self.assertIn('記録数: 0件',text)

    def test_rich_html_paste_is_formatted_and_sanitized(self):
        self.seed([base.task(progressEnabled=True,progressStage='doing')]);self.open_task()
        editor=self.input_summary()
        html='<h2>貼り付けた見出し</h2><p><strong>確定事項</strong></p><ul><li>一番目</li><li>二番目</li></ul><table><tr><th>項目</th><th>値</th></tr><tr><td>A</td><td>1</td></tr></table><a href="https://example.com/evidence">根拠</a><script>window.summaryAttack=1</script><a href="javascript:alert(1)">危険なリンク</a><img src="x" onerror="window.summaryAttack=1">'
        self.paste(editor,'貼り付けた内容',html)
        expect(editor.get_by_role('heading',name='貼り付けた見出し',exact=True)).to_be_visible()
        expect(editor.locator('strong')).to_have_text('確定事項');expect(editor.locator('table')).to_have_count(1)
        expect(editor.locator('[onerror],script,a[href^="javascript:"]')).to_have_count(0)
        self.save();viewer=self.show()
        expect(viewer.get_by_role('link',name='根拠',exact=True)).to_have_attribute('href','https://example.com/evidence')
        self.assertIsNone(self.page.evaluate('window.summaryAttack'))

    def test_image_clipboard_and_empty_input_never_clears_saved_summary(self):
        self.seed([base.task(progressEnabled=True,progressStage='doing')]);self.open_task()
        editor=self.input_summary();expect(self.page.get_by_role('button',name='要約を保存',exact=True)).to_be_disabled()
        self.ctx.grant_permissions(['clipboard-read','clipboard-write'])
        self.page.evaluate('''async bytes=>navigator.clipboard.write([new ClipboardItem({'image/png':new Blob([new Uint8Array(bytes)],{type:'image/png'})})])''',list(self.progress_png()))
        editor.click();editor.press('Control+V');expect(editor.locator('img')).to_be_visible();self.save()
        expect(self.show().locator('img')).to_be_visible()
        editor=self.input_summary();expect(self.page.get_by_role('button',name='要約を保存',exact=True)).to_be_disabled()
        self.page.get_by_role('button',name='最新の要約結果を表示',exact=True).last.click()
        expect(self.page.get_by_role('dialog',name='AI要約入力',exact=True)).to_have_count(0);expect(self.show().locator('img')).to_be_visible()


def load_tests(loader,tests,pattern):return unittest.TestSuite(AISummaryTests(name) for name in AISummaryTests.__dict__ if name.startswith('test_'))
if __name__=='__main__':unittest.main(verbosity=2)
