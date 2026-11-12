"""Board UI browser regressions: python3 scheduleapp/tests/test_progress_boards.py."""
import unittest
import test_progress as base
from playwright.sync_api import expect


class BoardsTests(base.ProgressTests):
    def open_task(self):
        self.page.get_by_label('大タスクのタイル',exact=True).get_by_role('button',name='進捗テスト案件',exact=True).click()

    def todo(self, id='s1'):
        return self.page.locator(f'[data-progress-subtask-id="{id}"]')

    def context(self, target, action, task=False):
        target.click(button='right')
        menu=self.page.get_by_role('menu',name='大タスクの設定' if task else 'やるべきことの設定',exact=True)
        expect(menu).to_be_visible()
        menu.get_by_role('menuitem',name=action,exact=True).click()

    def test_default_boards_scope_and_small_task_selection(self):
        original=base.task(progressEnabled=True,progressStage='todo')
        original['subtasks'][0]['smallTasks']=[dict(id='a',title='小作業')]
        self.seed([original])
        expect(self.page.get_by_role('heading',name='大タスクボード',exact=True)).to_be_visible()
        expect(self.page.get_by_role('heading',name='未着手ボード',exact=True)).to_have_count(0)
        self.open_task()
        expect(self.page.get_by_label('トークのタイトル',exact=True)).to_have_text('進捗テスト案件')
        self.todo().get_by_role('button',name='既存の調査のトークを表示',exact=True).click()
        expect(self.page.get_by_label('トークのタイトル',exact=True)).to_have_text('既存の調査')
        self.page.get_by_role('button',name='テーブル表示',exact=True).click()
        expect(self.page.get_by_label('進捗テーブル',exact=True)).to_be_visible()
        self.page.get_by_role('button',name='小作業のトークを表示',exact=True).click()
        expect(self.page.get_by_label('トークのタイトル',exact=True)).to_have_text('小作業')
        expect(self.page.get_by_role('button',name='トーク表示',exact=True)).to_have_attribute('aria-pressed','true')
        self.open_task()
        expect(self.page.get_by_label('トークのタイトル',exact=True)).to_have_text('進捗テスト案件')

    def test_todo_edit_status_hide_restore_and_persistence(self):
        original=base.task(progressEnabled=True,progressStage='doing')
        original['subtasks'][0]['smallTasks']=[dict(id='a',title='隠す小作業')]
        original['progressHistory']=[dict(id='hidden-talk',kind='comment',status='active',text='非表示対象の会話',subtaskIds=['s1'],subtaskTitles=['既存の調査'],smallTaskId='a',smallTaskTitle='隠す小作業'),dict(id='root-talk',kind='comment',status='active',text='全体だけの会話',subtaskIds=[])]
        self.seed([original]); self.open_task()
        self.context(self.todo(),'名前変更')
        d=self.page.get_by_role('dialog',name='名前変更',exact=True)
        d.get_by_label('名前',exact=True).fill('変更した調査'); d.get_by_role('button',name='保存',exact=True).click()
        self.context(self.todo(),'期限変更')
        d=self.page.get_by_role('dialog',name='期限変更',exact=True)
        d.get_by_label('期限',exact=True).fill(base.LATER);d.get_by_role('button',name='保存',exact=True).click()
        self.context(self.todo(),'ステータス変更')
        d=self.page.get_by_role('dialog',name='ステータス変更',exact=True)
        d.get_by_label('ステータス',exact=True).select_option('waiting');d.get_by_role('button',name='保存',exact=True).click()
        self.assertTrue(self.stored()[0]['subtasks'][0]['waiting'])
        self.context(self.todo(),'非表示')
        expect(self.todo()).to_have_count(0)
        expect(self.page.get_by_role('log',name='進捗履歴').get_by_text('非表示対象の会話',exact=True)).to_have_count(0)
        expect(self.page.get_by_role('log',name='進捗履歴').get_by_text('全体だけの会話',exact=True)).to_be_visible()
        self.page.get_by_role('button',name='テーブル表示',exact=True).click()
        expect(self.page.get_by_label('進捗テーブル',exact=True).get_by_text('非表示対象の会話',exact=True)).to_have_count(0)
        self.page.get_by_role('button',name='トーク表示',exact=True).click()
        self.assertEqual(len(self.stored()[0]['progressHistory']),2)
        self.send('非表示後の全体追記')
        self.assertTrue(self.stored()[0]['subtasks'][0]['progressHidden'])
        self.assertTrue(any(e['id']=='hidden-talk' for e in self.stored()[0]['progressHistory']))
        self.page.reload(); self.open_task();expect(self.todo()).to_have_count(0)
        self.context(self.card(),'やるべきこと再表示',task=True)
        d=self.page.get_by_role('dialog',name='やるべきこと再表示',exact=True)
        d.get_by_role('checkbox',name='変更した調査',exact=True).check()
        d.get_by_role('button',name='選択した項目を再表示',exact=True).click()
        expect(self.todo()).to_be_visible()
        self.assertFalse(self.stored()[0]['subtasks'][0]['progressHidden'])
        self.assertEqual(self.stored()[0]['subtasks'][0]['dueDate'],base.LATER)
        self.page.get_by_role('button',name='隠す小作業のトークを表示',exact=True).click()
        expect(self.page.get_by_role('log',name='進捗履歴').get_by_text('非表示対象の会話',exact=True)).to_be_visible()

    def test_context_deletion_cancel_and_confirm(self):
        self.seed([base.task(progressEnabled=True,progressStage='doing')]);self.open_task()
        self.page.once('dialog',lambda d:d.dismiss())
        self.context(self.todo(),'削除');expect(self.todo()).to_be_visible()
        self.page.once('dialog',lambda d:d.accept())
        self.context(self.todo(),'削除');expect(self.todo()).to_have_count(0)
        self.assertEqual([st['id'] for st in self.stored()[0]['subtasks']],['s2'])
        self.page.once('dialog',lambda d:d.dismiss())
        self.context(self.card(),'削除',task=True);expect(self.card()).to_be_visible()
        self.page.once('dialog',lambda d:d.accept())
        self.context(self.card(),'削除',task=True);expect(self.card()).to_have_count(0)
        self.assertEqual(self.stored(),[])

    def test_add_todo_and_task_tiles(self):
        self.seed([base.task(progressEnabled=True,progressStage='doing')]);self.open_task()
        self.page.get_by_role('button',name='やるべきことを追加',exact=True).click()
        d=self.page.get_by_role('dialog',name='やるべきことの追加',exact=True)
        d.get_by_label('名前',exact=True).fill('カードから追加')
        d.get_by_role('button',name='保存',exact=True).click()
        expect(self.page.get_by_role('button',name='カードから追加のトークを表示',exact=True)).to_be_visible()
        self.page.get_by_role('button',name='大タスクを追加',exact=True).click()
        expect(self.page.get_by_role('button',name='登録する',exact=True)).to_be_visible()
        # The existing task editor is used, with progress tracking enabled on save.
        self.page.get_by_placeholder('タスク名を入力').fill('追加した大タスク')
        self.page.get_by_role('button',name='登録する',exact=True).click()
        expect(self.page.get_by_label('大タスクのタイル',exact=True).get_by_role('button',name='追加した大タスク',exact=True)).to_be_visible()
        self.assertTrue(next(t for t in self.stored() if t['title']=='追加した大タスク')['progressEnabled'])

    def test_compact_context_switch_position_home_and_scroll(self):
        records=[base.task('other'+str(i),progressEnabled=True,progressStage='doing') for i in range(9)]
        records.append(base.task(progressEnabled=True,progressStage='doing'))
        self.seed(records)
        self.page.get_by_role('button',name='コンパクト表示',exact=True).click()
        self.open_task()
        expect(self.page.get_by_role('heading',name='やるべきことボード',exact=True)).to_have_count(0)
        expect(self.card().get_by_role('button',name='進捗テスト案件の設定',exact=True)).to_have_count(0)
        self.assertGreater(self.card().evaluate('el=>el.parentElement.scrollTop'),0)
        before=self.page.get_by_role('button',name='テーブル表示',exact=True).bounding_box()
        self.page.get_by_role('button',name='テーブル表示',exact=True).click()
        after=self.page.get_by_role('button',name='テーブル表示',exact=True).bounding_box()
        self.assertEqual(before,after)
        self.page.get_by_role('button',name='トーク表示',exact=True).click()
        self.context(self.card().get_by_text('クリックしてタスク全体のトークを表示',exact=True),'やるべきことの追加',task=True)
        d=self.page.get_by_role('dialog',name='やるべきことの追加',exact=True)
        d.get_by_label('名前',exact=True).fill('コンパクトで追加');d.get_by_role('button',name='保存',exact=True).click()
        expect(self.card().get_by_role('button',name='コンパクトで追加のトークを表示',exact=True)).to_be_visible()
        self.page.get_by_role('button',name='大タスクのホーム',exact=True).click()
        expect(self.page.get_by_label('大タスクのタイル',exact=True)).to_be_visible()
        self.open_task();self.assertGreater(self.card().evaluate('el=>el.parentElement.scrollTop'),0)
        self.page.screenshot(path='/tmp/schedule-compact.png')

    def test_talk_metadata_is_above_body_with_actions(self):
        original=base.task(progressEnabled=True,progressStage='doing')
        original['progressHistory']=[dict(id='talk',kind='comment',status='active',text='短い本文',subtaskIds=[],editedAt='2026-11-12T00:00:00Z')]
        self.seed([original]);self.open_task()
        entry=self.entry('talk');meta=entry.locator('[data-talk-meta]')
        expect(meta.get_by_role('button',name='コメントを編集',exact=True)).to_be_visible()
        self.assertLess(meta.bounding_box()['y'],entry.get_by_text('短い本文',exact=True).bounding_box()['y'])
        self.page.screenshot(path='/tmp/schedule-boards.png')


    def test_task_menu_edit_and_todo_complete_reopen(self):
        self.seed([base.task(progressEnabled=True,progressStage='doing')]);self.open_task()
        self.context(self.card(),'名前変更',task=True)
        d=self.page.get_by_role('dialog',name='名前変更',exact=True)
        d.get_by_label('名前',exact=True).fill('大タスク名変更');d.get_by_role('button',name='保存',exact=True).click()
        self.context(self.card(),'期限変更',task=True)
        d=self.page.get_by_role('dialog',name='期限変更',exact=True)
        d.get_by_label('期限',exact=True).fill(base.LATER);d.get_by_role('button',name='保存',exact=True).click()
        self.assertEqual(self.stored()[0]['dueDate'],base.LATER)
        for value in ['completed','active']:
            self.context(self.todo(),'ステータス変更')
            d=self.page.get_by_role('dialog',name='ステータス変更',exact=True)
            d.get_by_label('ステータス',exact=True).select_option(value);d.get_by_role('button',name='保存',exact=True).click()
            self.assertEqual(self.stored()[0]['subtasks'][0]['completed'],value=='completed')
        self.page.reload()
        expect(self.card().get_by_role('button',name='大タスク名変更',exact=True)).to_be_visible()

    def test_compact_legacy_todo_reorder(self):
        self.page.evaluate("localStorage.setItem('taskmatrix.progress.hideTodo','true')")
        base.ProgressTests.test_progress_todo_cards_reorder_by_drag_and_persist_without_moving_tasks(self)

    def test_compact_legacy_small_task_reorder(self):
        self.page.evaluate("localStorage.setItem('taskmatrix.progress.hideTodo','true')")
        base.ProgressTests.test_small_task_drag_reorders_within_parent_and_persists(self)

    def test_compact_legacy_rich_talk_and_backup(self):
        self.page.evaluate("localStorage.setItem('taskmatrix.progress.hideTodo','true')")
        base.ProgressTests.test_talk_images_links_edit_quote_and_backup_roundtrip(self)


    def test_compact_legacy_table_edit_quote_and_backup(self):
        self.page.evaluate("localStorage.setItem('taskmatrix.progress.hideTodo','true')")
        base.ProgressTests.test_talk_table_create_edit_send_reload_quote_and_backup(self)

    def test_compact_legacy_quote_wrapping(self):
        self.page.evaluate("localStorage.setItem('taskmatrix.progress.hideTodo','true')")
        base.ProgressTests.test_quote_collapse_accounts_for_wrapping_and_browser_resize(self)


    def test_restore_selects_only_checked_items_and_menu_scope(self):
        self.seed([base.task(progressEnabled=True,progressStage='doing')]);self.open_task()
        self.context(self.todo(),'非表示');self.context(self.todo('s2'),'非表示')
        self.context(self.card(),'やるべきこと再表示',task=True)
        d=self.page.get_by_role('dialog',name='やるべきこと再表示',exact=True)
        expect(d.get_by_role('checkbox')).to_have_count(2)
        d.get_by_role('checkbox',name='期限切れの確認',exact=True).check()
        d.get_by_role('button',name='選択した項目を再表示',exact=True).click()
        expect(self.todo()).to_have_count(0);expect(self.todo('s2')).to_be_visible()
        self.page.get_by_role('button',name='コンパクト表示',exact=True).click()
        # The parent card's free space opens its menu; a todo opens its own menu.
        self.card().get_by_text('クリックしてタスク全体のトークを表示',exact=True).click(button='right')
        expect(self.page.get_by_role('menu',name='大タスクの設定',exact=True)).to_be_visible()
        self.page.keyboard.press('Escape')
        self.todo('s2').click(button='right')
        expect(self.page.get_by_role('menu',name='やるべきことの設定',exact=True)).to_be_visible()
        expect(self.page.get_by_role('menu',name='大タスクの設定',exact=True)).to_have_count(0)


    def test_mode_and_home_switches_keep_unsent_draft(self):
        self.seed([base.task(progressEnabled=True,progressStage='doing')]);self.open_task()
        editor=self.page.get_by_label('進捗コメント',exact=True);editor.fill('切替時も残す未送信の文章')
        self.page.get_by_role('button',name='コンパクト表示',exact=True).click()
        expect(editor).to_have_text('切替時も残す未送信の文章')
        self.page.get_by_role('button',name='大タスクのホーム',exact=True).click();self.open_task()
        expect(editor).to_have_text('切替時も残す未送信の文章')
        self.page.get_by_role('button',name='テーブル表示',exact=True).click()
        self.page.get_by_role('button',name='トーク表示',exact=True).click()
        expect(editor).to_have_text('切替時も残す未送信の文章')
        self.page.get_by_role('button',name='コンパクト表示',exact=True).click()
        expect(editor).to_have_text('切替時も残す未送信の文章')
        self.send('切替時も残す未送信の文章')
        self.assertEqual(self.stored()[0]['progressHistory'][-1]['text'],'切替時も残す未送信の文章')


def load_tests(loader, tests, pattern):
    return unittest.TestSuite(BoardsTests(name) for name in BoardsTests.__dict__ if name.startswith('test_'))


if __name__=='__main__':unittest.main(verbosity=2)
