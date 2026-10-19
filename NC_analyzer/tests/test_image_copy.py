"""Browser regression tests: python3 NC_analyzer/tests/test_image_copy.py

Requires Python Playwright and Chromium (or `playwright install chromium`).
Uses real React/Babel/Chart.js and the native PNG clipboard. Excel is excluded.
"""
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from urllib.request import urlopen

from playwright.sync_api import expect, sync_playwright


class ImageCopyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.assets = tempfile.TemporaryDirectory(prefix='nc-copy-assets-')
        dependencies = {
            'react.js': 'react@18.3.1/umd/react.development.js',
            'react-dom.js': 'react-dom@18.3.1/umd/react-dom.development.js',
            'babel.js': '@babel/standalone@7.26.9/babel.min.js',
            'chart.js': 'chart.js@4.5.1/dist/chart.umd.min.js',
        }
        for name, package in dependencies.items():
            with urlopen('https://cdn.jsdelivr.net/npm/' + package, timeout=30) as response:
                Path(cls.assets.name, name).write_bytes(response.read())
        cls.playwright = sync_playwright().start()
        options = {'args': ['--no-sandbox']}
        if chromium := shutil.which('chromium'):
            options['executable_path'] = chromium
        cls.browser = cls.playwright.chromium.launch(**options)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.assets.cleanup()

    def setUp(self):
        self.context = self.browser.new_context(
            permissions=['clipboard-read', 'clipboard-write'],
            viewport={'width': 1400, 'height': 1000},
        )
        self.page = self.context.new_page()
        self.errors = []
        self.editor = False
        self.exported_html = None
        self.settings = {}
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.route('**/*', self.route)

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [])

    def route(self, route):
        url = route.request.url
        if url.startswith(('https://nc-analyzer.test/', 'http://nc-analyzer.test/')):
            if url.endswith('/exported.html'):
                route.fulfill(body=self.exported_html, content_type='text/html')
                return
            source = Path(__file__).resolve().parents[1].joinpath('index.html').read_text()
            state = {
                'groups': ['Group 1'], 'projects': ['Project 1'], 'visibleNcCurves': [15],
                'useFixedCopyAspectRatio': self.fixed,
                'dataItems': [{
                    'id': 'measurement', 'groupName': 'Group 1', 'fileName': 'sample.txt',
                    'legendName': 'Measurement', 'isVisible': True, 'isOriginalThird': False,
                    'rawFreqs': [63, 125, 250, 500, 1000, 2000, 4000, 8000],
                    'rawValues': [30] * 8,
                }],
            }
            state.update(self.settings)
            self.app_state = state
            if not self.editor:
                source = source.replace('<div id="root"></div>',
                    '<div id="root"></div><script id="initial-data" type="text/plain">'
                    + json.dumps(state) + '</script>', 1)
            route.fulfill(body=source, content_type='text/html')
            return
        asset = next((name for token, name in [
            ('react-dom@', 'react-dom.js'), ('react@', 'react.js'),
            ('babel', 'babel.js'), ('/npm/chart.js', 'chart.js'),
        ] if token in url), None)
        if asset:
            route.fulfill(path=Path(self.assets.name, asset), content_type='application/javascript')
        else:
            # Layout styles and the Excel engine are outside this clipboard test.
            body = 'window.loadPyodide = async () => { throw new Error("Excel excluded"); };' if 'pyodide.js' in url else ''
            route.fulfill(body=body, content_type='application/javascript')

    def open_app(self, fixed=False, secure=True, editor=False, settings=None):
        self.fixed = fixed
        self.editor = editor
        self.settings = settings or {}
        self.page.goto(('https' if secure else 'http') + '://nc-analyzer.test/')
        if editor:
            self.import_workspace(self.app_state)
        expect(self.page.locator('[title="凡例（スクロール可能）"] > div')).to_have_count(2)

    def import_workspace(self, state):
        self.page.locator('input[type=file][accept=".json"]:not([multiple])').set_input_files({
            'name': 'copy-settings.json', 'mimeType': 'application/json',
            'buffer': json.dumps(state).encode(),
        })

    def set_ratio(self, target, width, height):
        self.page.get_by_label('コピー比固定', exact=True).check()
        self.page.get_by_label('コピー比の固定範囲').select_option(target)
        self.page.get_by_label('コピー比の横').fill(str(width))
        self.page.get_by_label('コピー比の縦').fill(str(height))

    def click_copy(self, kind, columns=1):
        names = {'graph': 'グラフ単体をコピー', 'legend': '凡例単体をコピー',
                 'combined': 'グラフと凡例を一体でコピー'}
        self.page.get_by_role('button', name=names[kind], exact=True).click()
        if kind == 'legend':
            self.page.get_by_role('button', name=f'{columns}段', exact=True).click()
            self.page.get_by_role('button', name='コピー', exact=True).click()

    def copied_png(self, kind, columns=1):
        # A sentinel prevents a stale clipboard image from passing the check.
        self.page.evaluate('navigator.clipboard.writeText("not-an-image")')
        before = self.page.evaluate('Object.keys(Chart.instances).length')
        self.click_copy(kind, columns)
        expect(self.page.get_by_role('status')).to_have_text('コピーしました')
        self.assertEqual(self.page.evaluate('Object.keys(Chart.instances).length'), before)
        image = self.page.evaluate('''async () => {
            const [item] = await navigator.clipboard.read();
            const blob = await item.getType('image/png');
            const bitmap = await createImageBitmap(blob);
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.width; canvas.height = bitmap.height;
            const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0);
            const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            let ink = 0;
            for (let i = 0; i < pixels.length; i += 4) {
                if (pixels[i+3] && Math.min(pixels[i], pixels[i+1], pixels[i+2]) < 200) ink++;
            }
            bitmap.close();
            return {width: canvas.width, height: canvas.height, ink};
        }''')
        self.assertGreater(image['ink'], 30)
        return image

    def test_graph_fixed_and_normal_png(self):
        for fixed in [False, True]:
            with self.subTest(fixed=fixed):
                self.open_app(fixed=fixed)
                image = self.copied_png('graph')
                self.assertEqual(image['width'], 1537 if fixed else 1200)
                if fixed:
                    self.assertEqual(image['height'], 1287)

    def test_legend_columns_png(self):
        self.open_app()
        widths = [self.copied_png('legend', columns)['width'] for columns in [1, 3, 6]]
        self.assertLess(widths[0], widths[1])
        self.assertLess(widths[1], widths[2])

    def test_combined_png(self):
        self.open_app(fixed=True)
        self.assertGreater(self.copied_png('combined')['width'], 1537)

    def test_numeric_ratio_for_graph_area(self):
        self.open_app()
        self.set_ratio('graph', 4, 3)
        graph = self.copied_png('graph')
        self.assertAlmostEqual(graph['width'] / graph['height'], 4 / 3, delta=0.001)
        combined = self.copied_png('combined')
        self.assertEqual(combined['height'], graph['height'])
        self.assertGreater(combined['width'], graph['width'])

    def test_numeric_ratio_for_whole_image(self):
        self.open_app()
        for width, height in [(16, 9), (3, 4), (1.5, 1)]:
            with self.subTest(ratio=(width, height)):
                self.set_ratio('combined', width, height)
                image = self.copied_png('combined')
                self.assertAlmostEqual(image['width'] / image['height'], width / height, delta=0.001)

    def test_invalid_ratio_does_not_copy_or_allocate_export_chart(self):
        self.open_app()
        self.set_ratio('combined', 0, 9)
        expect(self.page.get_by_role('alert')).to_contain_text('0より大きい数値')
        before = self.page.evaluate('Object.keys(Chart.instances).length')
        self.click_copy('combined')
        expect(self.page.get_by_role('status')).to_contain_text('0より大きい数値')
        self.set_ratio('graph', 1, 1000000)
        self.click_copy('graph')
        expect(self.page.get_by_role('status')).to_contain_text('横・縦の値を調整')
        self.assertEqual(self.page.evaluate('Object.keys(Chart.instances).length'), before)

    def test_ratio_settings_survive_json_and_html_export(self):
        self.open_app(editor=True)
        self.page.get_by_role('button', name='👁️ プレビュー', exact=True).click()
        self.set_ratio('combined', 16, 9)
        self.page.get_by_role('button', name='✏️ 編集に戻る', exact=True).click()
        expected = {'target': 'combined', 'width': 16, 'height': 9}
        with self.page.expect_download() as download:
            self.page.get_by_role('button', name='💾 ワークスペース保存', exact=True).click()
        saved = json.loads(Path(download.value.path()).read_text())
        self.assertEqual(saved['copyAspectRatio'], expected)
        with self.page.expect_download() as download:
            self.page.get_by_role('button', name='💾 プロジェクト保存', exact=True).click()
        self.assertEqual(json.loads(Path(download.value.path()).read_text())['copyAspectRatio'], expected)
        self.page.get_by_role('button', name='👁️ プレビュー', exact=True).click()
        self.set_ratio('graph', 1, 1)
        self.page.get_by_role('button', name='✏️ 編集に戻る', exact=True).click()
        self.import_workspace(saved)
        self.page.get_by_role('button', name='👁️ プレビュー', exact=True).click()
        expect(self.page.get_by_label('コピー比の横')).to_have_value('16')
        expect(self.page.get_by_label('コピー比の縦')).to_have_value('9')
        expect(self.page.get_by_label('コピー比の固定範囲')).to_have_value('combined')
        self.page.get_by_role('button', name='✏️ 編集に戻る', exact=True).click()
        self.page.get_by_role('button', name='🌐 HTML出力', exact=True).click()
        with self.page.expect_download() as download:
            self.page.get_by_role('button', name='HTML出力', exact=True).click()
        self.exported_html = Path(download.value.path()).read_text()
        self.page.goto('https://nc-analyzer.test/exported.html')
        expect(self.page.get_by_label('コピー比の固定範囲')).to_have_value('combined')
        expect(self.page.get_by_label('コピー比の横')).to_have_value('16')
        image = self.copied_png('combined')
        self.assertAlmostEqual(image['width'] / image['height'], 16 / 9, delta=0.001)

    def test_legacy_workspace_resets_new_settings_to_defaults(self):
        self.open_app(fixed=True, editor=True)
        legacy = dict(self.app_state)
        self.page.get_by_role('button', name='👁️ プレビュー', exact=True).click()
        self.set_ratio('combined', 1, 1)
        self.page.get_by_role('button', name='✏️ 編集に戻る', exact=True).click()
        self.import_workspace(legacy)
        self.page.get_by_role('button', name='👁️ プレビュー', exact=True).click()
        expect(self.page.get_by_label('コピー比の固定範囲')).to_have_value('graph')
        expect(self.page.get_by_label('コピー比の横')).to_have_value('1537')
        expect(self.page.get_by_label('コピー比の縦')).to_have_value('1287')
        self.assertEqual(self.copied_png('graph')['height'], 1287)

    def test_ratio_is_included_in_undo_and_redo(self):
        self.open_app(fixed=True, editor=True)
        self.page.get_by_role('button', name='👁️ プレビュー', exact=True).click()
        self.page.get_by_label('コピー比の固定範囲').select_option('combined')
        self.page.get_by_role('button', name='✏️ 編集に戻る', exact=True).click()
        self.page.get_by_role('button', name='↶ Undo', exact=True).click()
        self.page.get_by_role('button', name='👁️ プレビュー', exact=True).click()
        expect(self.page.get_by_label('コピー比の固定範囲')).to_have_value('graph')
        self.page.get_by_role('button', name='✏️ 編集に戻る', exact=True).click()
        self.page.get_by_role('button', name='↷ Redo', exact=True).click()
        self.page.get_by_role('button', name='👁️ プレビュー', exact=True).click()
        expect(self.page.get_by_label('コピー比の固定範囲')).to_have_value('combined')

    def test_clipboard_write_starts_before_delayed_png_encoding(self):
        self.open_app()
        self.page.evaluate('''() => {
            const toBlob = HTMLCanvasElement.prototype.toBlob;
            HTMLCanvasElement.prototype.toBlob = function(callback, ...args) {
                window.pngFinished = false;
                toBlob.call(this, blob => setTimeout(() => {
                    window.pngFinished = true; callback(blob);
                }, 50), ...args);
            };
            const write = navigator.clipboard.write.bind(navigator.clipboard);
            navigator.clipboard.write = items => {
                window.writeStartedBeforePng = !window.pngFinished;
                return write(items);
            };
        }''')
        self.copied_png('legend')
        self.assertTrue(self.page.evaluate('window.writeStartedBeforePng'))

    def assert_manual_copy(self, kind):
        before = self.page.evaluate('Object.keys(Chart.instances).length')
        self.click_copy(kind)
        dialog = self.page.get_by_role('dialog', name='コピー用画像')
        expect(dialog).to_be_visible()
        image = dialog.get_by_role('img')
        expect(image).to_have_js_property('complete', True)
        self.assertGreater(image.evaluate('(img) => img.naturalWidth'), 0)
        url = image.get_attribute('src')
        self.assertEqual(self.page.evaluate('Object.keys(Chart.instances).length'), before)
        dialog.get_by_role('button', name='閉じる').click()
        expect(dialog).to_have_count(0)
        self.assertTrue(self.page.evaluate('''async url => {
            try { await fetch(url); return false; } catch { return true; }
        }''', url))

    def test_denied_clipboard_shows_copyable_image(self):
        self.open_app(fixed=True)
        self.page.evaluate('''() => {
            navigator.clipboard.write = async () => {
                throw new DOMException('Denied', 'NotAllowedError');
            };
        }''')
        self.assert_manual_copy('graph')
        self.assert_manual_copy('legend')

    def test_insecure_context_shows_copyable_image(self):
        self.open_app(secure=False)
        self.assert_manual_copy('legend')

    def test_encoding_failure_is_visible_and_releases_export_chart(self):
        self.open_app(fixed=True)
        self.page.evaluate('''() => {
            HTMLCanvasElement.prototype.toBlob = callback => setTimeout(() => callback(null), 0);
        }''')
        before = self.page.evaluate('Object.keys(Chart.instances).length')
        self.click_copy('graph')
        expect(self.page.get_by_role('status')).to_have_text('画像を作成できませんでした。もう一度お試しください。')
        self.assertEqual(self.page.evaluate('Object.keys(Chart.instances).length'), before)


if __name__ == '__main__':
    unittest.main(verbosity=2)
