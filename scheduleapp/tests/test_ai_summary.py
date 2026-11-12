"""Task-wide AI handoff and atomic Markdown routing: python3 scheduleapp/tests/test_ai_summary.py."""
import base64
import io
import json
from pathlib import Path
import unittest
from urllib.parse import quote
import xml.etree.ElementTree as ET
import zipfile
import test_progress as base
from playwright.sync_api import expect


class AISummaryTests(base.ProgressTests):
    def open_task(self):
        self.card(self.stored()[0]['id']).get_by_role('button',name='進捗テスト案件',exact=True).click()

    def context(self, action):
        self.card(self.stored()[0]['id']).get_by_role('button',name='進捗テスト案件',exact=True).click(button='right')
        self.page.get_by_role('menu',name='大タスクの設定',exact=True).get_by_role('menuitem',name=action,exact=True).click()

    def export(self):
        with self.page.expect_download() as download:self.context('AI要約用Wordを出力')
        return Path(download.value.path()).read_bytes()

    def editor(self):
        self.context('AI要約を入力')
        editor=self.page.get_by_role('textbox',name='AI要約の入力欄',exact=True)
        expect(editor).to_be_empty();return editor

    def paste(self, editor, value, html=None):
        self.ctx.grant_permissions(['clipboard-read','clipboard-write'])
        if html:self.page.evaluate('''async ({html,plain})=>navigator.clipboard.write([new ClipboardItem({'text/html':new Blob([html],{type:'text/html'}),'text/plain':new Blob([plain],{type:'text/plain'})})])''',dict(html=html,plain=value))
        else:self.page.evaluate('text=>navigator.clipboard.writeText(text)',value)
        editor.click();editor.press('Control+A');editor.press('Control+V')

    def marker(self, kind, id):return '[AI_'+kind+':'+quote(str(id),safe='')+']'

    def bundle(self, root='全体の要約', todo='作業の要約'):
        task=self.stored()[0];snapshot=task['aiSummaryExport']
        lines=['# '+task['title']+' '+self.marker('BATCH',snapshot['id']),'## 全体要約 '+self.marker('TASK',task['id']),root]
        for st in task['subtasks']:
            if not st.get('progressHidden'):lines+=['## やるべきこと：'+st['title']+' '+self.marker('TODO',st['id']),todo+' '+st['id']]
        return '\n\n'.join(lines)

    def save(self):
        self.page.get_by_role('button',name='要約を保存',exact=True).click()
        expect(self.page.get_by_role('dialog',name='AI要約入力',exact=True)).to_have_count(0)

    def show(self):
        self.page.get_by_role('button',name='AI要約',exact=True).click()
        return self.page.get_by_role('region',name='AI要約の表示',exact=True)

    def test_bulk_markdown_route_latest_blank_replacement_and_backup(self):
        self.seed([base.task(progressEnabled=True,progressStage='doing')]);self.open_task();self.export()
        editor=self.editor();image='data:image/png;base64,'+base64.b64encode(self.progress_png()).decode()
        root='### 前回からの進捗\n\n**重要な結論**\n\n- 決定\n  - 次の行動\n\n| 担当 | 期限 |\n| --- | --- |\n| 田中 | 明日 |\n\n[仕様書](https://example.com/spec)\n\n![結果]('+image+')'
        self.paste(editor,self.bundle(root,'項目ごとのまとめ'))
        expect(editor.locator('strong')).to_have_text('重要な結論');expect(editor.locator('table')).to_have_count(1)
        self.save();viewer=self.show()
        expect(viewer.locator('strong')).to_have_text('重要な結論');expect(viewer.get_by_role('img',name='結果',exact=True)).to_be_visible()
        expect(viewer.locator('table')).to_contain_text('田中')
        expect(viewer.get_by_role('link',name='仕様書',exact=True)).to_have_attribute('href','https://example.com/spec')
        expect(viewer.get_by_role('region',name='既存の調査の要約',exact=True)).to_contain_text('項目ごとのまとめ s1')
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
        expect(self.show()).to_contain_text('項目ごとのまとめ s1');expect(self.show()).not_to_contain_text('重要な結論')
        editor=self.editor();self.paste(editor,self.bundle('更新した全体','更新した個別'));self.save()
        self.open_task();expect(self.show()).to_contain_text('更新した全体');expect(self.show()).not_to_contain_text('重要な結論')
        editor=self.editor();expect(self.page.get_by_role('button',name='要約を保存',exact=True)).to_be_disabled()
        self.page.get_by_role('button',name='キャンセル',exact=True).click()
        self.page.reload();self.open_task();expect(self.show()).to_contain_text('更新した全体')
        with self.page.expect_download() as download:self.page.get_by_role('button',name='エクスポート',exact=True).click()
        data=json.loads(Path(download.value.path()).read_text());self.assertEqual(len(data['tasks'][0]['aiSummaries']),3)
        self.seed([]);self.page.get_by_label('バックアップをインポート',exact=True).set_input_files(dict(name='summary.json',mimeType='application/json',buffer=json.dumps(data).encode()))
        self.open_task();expect(self.show()).to_contain_text('更新した全体')
        self.page.screenshot(path='/tmp/schedule-ai-summary-bundle.png')

    def test_invalid_bundle_never_partially_overwrites_summaries(self):
        self.seed([base.task(progressEnabled=True,progressStage='doing')]);self.open_task();self.export()
        editor=self.editor();valid=self.bundle();self.paste(editor,valid);self.save();saved=self.stored()[0]['aiSummaries']
        editor=self.editor()
        bad=[('前置きのみ','ID'),(valid.replace(self.marker('TASK','track'),self.marker('TASK','wrong')),'別の大タスク'),(valid.split('## やるべきこと：')[0],'不足'),(valid+'\n\n## 重複 '+self.marker('TODO','s1')+'\n重複本文','重複'),(valid.replace(self.marker('TODO','s1'),self.marker('TODO','alien')),'対象外'),(valid.replace(self.stored()[0]['aiSummaryExport']['id'],'old-batch'),'出力回'),('```markdown\n'+valid+'\n```','出力回')]
        for value,message in bad:
            self.paste(editor,value);self.page.get_by_role('button',name='要約を保存',exact=True).click()
            expect(self.page.get_by_role('alert')).to_contain_text(message);self.assertEqual(self.stored()[0]['aiSummaries'],saved)
        self.paste(editor,valid);self.save()

    def test_task_only_context_and_empty_child_actions_cover_entire_task(self):
        task=base.task(progressEnabled=True,progressStage='doing');task['subtasks'][0]['smallTasks']=[dict(id='tiny',title='小作業')]
        task['progressHistory']=[dict(id='root',kind='comment',status='active',text='全体の記録',subtaskIds=[]),dict(id='one',kind='comment',status='active',text='調査の記録',subtaskIds=['s1']),dict(id='two',kind='comment',status='active',text='別項目の記録',subtaskIds=['s2'])]
        self.seed([task]);self.open_task()
        expect(self.page.get_by_role('button',name='AI要約用Wordを出力',exact=True)).to_have_count(0)
        expect(self.page.get_by_role('button',name='AI要約を入力',exact=True)).to_have_count(0)
        self.page.locator('[data-progress-subtask-id="s1"]').click(button='right')
        menu=self.page.get_by_role('menu',name='やるべきことの設定',exact=True)
        expect(menu.get_by_role('menuitem',name='AI要約を入力',exact=True)).to_have_count(0);self.page.keyboard.press('Escape')
        self.page.get_by_role('button',name='小作業のトークを表示',exact=True).click();viewer=self.show()
        with self.page.expect_download() as download:viewer.get_by_role('button',name='AI要約用Wordを出力',exact=True).click()
        with zipfile.ZipFile(download.value.path()) as z:
            text=z.read('word/document.xml').decode()
            for value in ['全体の記録','調査の記録','別項目の記録']:self.assertIn(value,text)
        viewer.get_by_role('button',name='AI要約を入力',exact=True).click()
        expect(self.page.get_by_role('dialog',name='AI要約入力')).to_contain_text('進捗テスト案件（全体と各やるべきことを一括入力）')
        editor=self.page.get_by_role('textbox',name='AI要約の入力欄');self.paste(editor,self.bundle());self.save()
        expect(self.show()).to_contain_text('作業の要約 s1')
        self.page.get_by_role('button',name='その他のトークを表示',exact=True).click();expect(self.show()).to_contain_text('全体の要約')
        self.page.get_by_role('checkbox',name='コンパクト表示',exact=True).check()
        expect(self.show()).to_contain_text('全体の要約')
        self.context('AI要約を入力');expect(self.page.get_by_role('textbox',name='AI要約の入力欄')).to_be_empty()
        self.page.get_by_role('button',name='キャンセル',exact=True).click()

    def test_word_previous_summary_progress_diff_images_tables_links_hidden_exclusion(self):
        task=base.task(progressEnabled=True,progressStage='doing')
        task['subtasks'].append(dict(id='secret',title='非表示項目',progressHidden=True))
        task['progressHistory']=[dict(id='source',kind='comment',status='active',text='検証結果\n\n| 項目 | 値 |\n| --- | --- |\n| 電圧 | 12V |',subtaskIds=['s1'],images=[dict(name='結果.png',src='data:image/png;base64,'+base64.b64encode(self.progress_png()).decode())],links=[dict(label='仕様リンク',url='https://example.com/spec')]),dict(id='hidden',kind='comment',status='active',text='隠した会話',subtaskIds=['secret'])]
        self.seed([task]);self.open_task();self.export();editor=self.editor();self.paste(editor,self.bundle('前回の全体要約','前回の項目要約'));self.save()
        task=self.stored()[0];task['progressHistory'][0]['text']+='\n更新した条件';task['progressHistory'].append(dict(id='added',kind='comment',status='active',text='今回進んだ確認',subtaskIds=['s2']))
        self.seed([task]);self.open_task();self.page.get_by_label('履歴を検索',exact=True).fill('一致しない検索')
        raw=self.export()
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'};root=ET.fromstring(z.read('word/document.xml'));text='\n'.join(n.text or '' for n in root.findall('.//w:t',ns))
            for value in ['前回の全体要約','前回の項目要約 s1','前回からの進捗','追加された記録ID: added','更新された記録ID: source','今回進んだ確認','Markdown形式','画像・表・URLを効果的に','12V',self.marker('TASK','track'),self.marker('TODO','s1')]:self.assertIn(value,text)
            self.assertNotIn('隠した会話',text);self.assertNotIn(self.marker('TODO','secret'),text)
            self.assertEqual(len(root.findall('.//w:tbl',ns)),1);self.assertTrue(any(n.startswith('word/media/') for n in z.namelist()))
            self.assertIn('https://example.com/spec',z.read('word/_rels/document.xml.rels').decode())

    def test_export_watermark_excludes_later_talk_and_changed_manifest_is_rejected(self):
        task=base.task(progressEnabled=True,progressStage='doing',progressHistory=[dict(id='old',kind='comment',text='出力済みの記録',subtaskIds=[])])
        self.seed([task]);self.open_task();self.export();first=self.bundle()
        task=self.stored()[0];task['progressHistory'].append(dict(id='later',kind='comment',text='出力後に追加された記録',subtaskIds=[]))
        self.seed([task]);self.open_task();editor=self.editor();self.paste(editor,first);self.save()
        self.assertNotIn('later',self.stored()[0]['aiSummaries'][json.dumps(['task','track'],separators=(',',':'))]['sourceEntries'])
        raw=self.export()
        with zipfile.ZipFile(io.BytesIO(raw)) as z:self.assertIn('追加された記録ID: later',z.read('word/document.xml').decode())
        current=self.bundle();task=self.stored()[0];task['subtasks'][1]['progressHidden']=True
        self.seed([task]);self.open_task();editor=self.editor();self.paste(editor,current)
        self.page.get_by_role('button',name='要約を保存',exact=True).click();expect(self.page.get_by_role('alert')).to_contain_text('Word出力後')

    def test_rich_html_heading_markers_and_renamed_duplicate_titles_route_by_id(self):
        task=base.task(progressEnabled=True,progressStage='doing')
        for st in task['subtasks']:st['title']='同じ名前'
        self.seed([task]);self.open_task();self.export()
        snapshot=self.stored()[0]['aiSummaryExport'];html='<h1>案件 '+self.marker('BATCH',snapshot['id'])+'</h1><h2>全体 '+self.marker('TASK','track')+'</h2><p><strong>全体の結論</strong></p><h2>同じ名前 '+self.marker('TODO','s1')+'</h2><p>一番目の結論</p><h2>同じ名前 '+self.marker('TODO','s2')+'</h2><p>二番目の結論</p><script>window.summaryAttack=1</script><a href="javascript:alert(1)">危険</a>'
        task=self.stored()[0];task['subtasks'][0]['title']='変更後の名前';self.seed([task]);self.open_task()
        editor=self.editor();self.paste(editor,'要約',html);expect(editor.locator('script,a[href^="javascript:"]')).to_have_count(0);self.save()
        self.page.get_by_role('button',name='変更後の名前のトークを表示',exact=True).click();expect(self.show()).to_contain_text('一番目の結論');expect(self.show()).not_to_contain_text('二番目の結論')
        self.assertIsNone(self.page.evaluate('window.summaryAttack'))

    def test_no_todos_allows_only_overall_and_input_requires_export(self):
        task=base.task(progressEnabled=True,progressStage='doing');task['subtasks']=[]
        self.seed([task]);self.open_task();editor=self.editor();self.paste(editor,'# 任意の文章');self.page.get_by_role('button',name='要約を保存',exact=True).click()
        expect(self.page.get_by_role('alert')).to_contain_text('先に');self.page.get_by_role('button',name='キャンセル',exact=True).click()
        self.export();editor=self.editor();self.paste(editor,self.bundle('全体のみの要約'));self.save()
        self.assertEqual(len(self.stored()[0]['aiSummaries']),1);expect(self.show()).to_contain_text('全体のみの要約')


    def test_real_ids_keep_underscores_when_pasted_as_markdown_or_styled_html(self):
        task=base.task(progressEnabled=True,progressStage='doing')
        task['id']='t_1793949728983_ix1rt6m'
        task['subtasks'][0]['id']='st_1793949728983_first'
        task['subtasks'][1]['id']='st_1793949728983_second'
        self.seed([task]);self.open_task();self.export()
        value=self.bundle('スクリーンショット形式の全体要約','項目別の結論')
        editor=self.editor();self.paste(editor,value)
        for kind,id in [('TASK',task['id']),('TODO',task['subtasks'][0]['id']),('TODO',task['subtasks'][1]['id'])]:
            expect(editor).to_contain_text(self.marker(kind,id))
        expect(editor.locator('h1 em,h2 em')).to_have_count(0)
        self.save();expect(self.show()).to_contain_text('スクリーンショット形式の全体要約')
        editor=self.editor();snapshot=self.stored()[0]['aiSummaryExport']
        html='<h1>進捗テスト案件 <strong>'+self.marker('BATCH',snapshot['id'])+'</strong></h1><p>全体要約 <em>'+self.marker('TASK',task['id'])+'</em></p><p><strong>更新した全体</strong></p>'
        for st in task['subtasks']:
            html+='<h2><strong>'+st['title']+' '+self.marker('TODO',st['id'])+'</strong></h2><p>更新した項目 '+st['title']+'</p>'
        self.paste(editor,'Copilotの書式付き回答',html)
        for st in task['subtasks']:expect(editor).to_contain_text(self.marker('TODO',st['id']))
        self.save();expect(self.show()).to_contain_text('更新した全体')
        self.page.get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
        expect(self.show()).to_contain_text('更新した項目 '+task['subtasks'][0]['title'])
        self.assertIn('**更新した全体**',self.stored()[0]['aiSummaries'][json.dumps(['task',task['id']],separators=(',',':'))]['markdown'])


    def test_fresh_export_excludes_all_prior_ai_material_and_keeps_crosscut_in_both_modes(self):
        task=base.task(progressEnabled=True,progressStage='doing')
        image='data:image/png;base64,'+base64.b64encode(self.progress_png()).decode()
        rootkey=json.dumps(['task',task['id']],separators=(',',':'))
        todokey=json.dumps(['todo','s1'],separators=(',',':'))
        task['aiSummaries']={rootkey:dict(markdown='PRIOR_ROOT_ONLY\n\n![前回だけの画像]('+image+')\n\n[前回だけのリンク](https://example.com/prior-only)',updatedAt='2020-01-02T00:00:00Z',sourceExportedAt='2020-01-01T00:00:00Z',sourceEntries={}),todokey:dict(markdown='PRIOR_TODO_ONLY',updatedAt='2020-01-02T00:00:00Z')}
        task['progressHistory']=[dict(id='source',kind='comment',status='active',text='元のトーク\n\n| 項目 | 値 |\n| --- | --- |\n| 数値 | 12 |',subtaskIds=['s1'],images=[dict(name='元記録の画像',src=image)],links=[dict(label='元資料',url='https://example.com/original')])]
        self.seed([task]);self.open_task();original=self.stored()[0]['aiSummaries']
        for include in [True,False]:
            with self.page.expect_download() as download:self.context('AI要約用Wordを出力' if include else 'AI要約用Wordを出力（前回要約なし）')
            if not include:self.assertIn('前回要約なし',download.value.suggested_filename)
            with zipfile.ZipFile(download.value.path()) as z:
                ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
                text='\n'.join(n.text or '' for n in ET.fromstring(z.read('word/document.xml')).findall('.//w:t',ns))
                for phrase in ['全体要約はやるべきこと別に章立てせず','複数の作業を横断した論点・判断テーマごとに整理','元のトーク','数値',self.marker('TASK','track'),self.marker('TODO','s1')]:self.assertIn(phrase,text)
                self.assertEqual(len(ET.fromstring(z.read('word/document.xml')).findall('.//w:tbl',ns)),1)
                relations=z.read('word/_rels/document.xml.rels').decode();self.assertIn('https://example.com/original',relations)
                media=[n for n in z.namelist() if n.startswith('word/media/')]
                if include:
                    for phrase in ['PRIOR_ROOT_ONLY','PRIOR_TODO_ONLY','前回の要約（参考情報）','前回との記録比較']:self.assertIn(phrase,text)
                    self.assertIn('https://example.com/prior-only',relations);self.assertEqual(len(media),2)
                else:
                    for phrase in ['PRIOR_ROOT_ONLY','PRIOR_TODO_ONLY','前回だけの画像','前回だけのリンク','前回の要約（参考情報）','前回との記録比較','2020-01-01','2020-01-02']:self.assertNotIn(phrase,text)
                    self.assertNotIn('https://example.com/prior-only',relations);self.assertEqual(len(media),1)
                    self.assertIn('過去の回答を参照・継承せず',text)
            self.assertEqual(self.stored()[0]['aiSummaries'],original)
            self.assertEqual(self.stored()[0]['aiSummaryExport']['includePrevious'],include)
        editor=self.editor();self.paste(editor,self.bundle('新しく考え直した全体','新しい項目要約'));self.save()
        expect(self.show()).to_contain_text('新しく考え直した全体')


def load_tests(loader,tests,pattern):return unittest.TestSuite(AISummaryTests(name) for name in AISummaryTests.__dict__ if name.startswith('test_'))
if __name__=='__main__':unittest.main(verbosity=2)
