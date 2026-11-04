"""Run from the repository root: python3 calculator/tests/test_weight_conversion.py.

Requires Playwright 1.62.0 and Chromium; downloads pinned browser assets over TLS.
"""
from pathlib import Path
import re
import shutil
import unittest
from urllib.request import urlopen

from playwright.sync_api import expect, sync_playwright


class WeightConversionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        dependencies = {
            'react.js': 'react@18.3.1/umd/react.development.js',
            'react-dom.js': 'react-dom@18.3.1/umd/react-dom.development.js',
            'babel.js': '@babel/standalone@7.26.9/babel.min.js',
            'icons.js': 'lucide-react@0.468.0/dist/umd/lucide-react.js',
        }
        cls.assets = {}
        for name, package in dependencies.items():
            with urlopen('https://cdn.jsdelivr.net/npm/' + package, timeout=30) as response:
                cls.assets[name] = response.read()
        source = Path(__file__).resolve().parents[1].joinpath('index.jsx').read_text()
        source = re.sub(r"import React, \{([^}]+)\} from 'react';", r'const {\1} = React;', source)
        source = re.sub(r"import \{([^}]+)\} from 'lucide-react';", r'const {\1} = window.LucideReact;', source)
        cls.source = source.replace('export default function App()', 'function App()')
        cls.source += "\nReactDOM.createRoot(document.getElementById('root')).render(<App/>);"
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(executable_path=shutil.which('chromium'), args=['--no-sandbox'])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.pw.stop()

    def setUp(self):
        self.context = self.browser.new_context()
        self.context.route('https://calculator.test/**', self.route)
        self.page = self.context.new_page()
        self.errors = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))
        self.page.goto('https://calculator.test/')
        self.input = self.page.get_by_role('textbox')
        expect(self.input).to_be_visible()

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [])

    def route(self, route):
        name = route.request.url.rsplit('/', 1)[-1]
        if not name:
            route.fulfill(content_type='text/html', body='''<!doctype html><meta charset="utf-8">
                <script src="/react.js"></script><script>window.react=React;</script>
                <script src="/react-dom.js"></script><script src="/icons.js"></script>
                <script src="/babel.js"></script><div id="root"></div>
                <script type="text/babel" src="/app.jsx"></script>''')
        else:
            route.fulfill(content_type='application/javascript',
                          body=self.source if name == 'app.jsx' else self.assets[name])

    def test_mass_length_preserves_original_and_adds_torque(self):
        self.input.fill('1m * 1kg')
        expect(self.page.get_by_text('1 m·kg', exact=True)).to_be_visible()
        expect(self.page.get_by_text('9.80665 N·m', exact=True)).to_be_visible()
        expect(self.page.get_by_text('0.009807 kN·m', exact=True)).to_be_visible()
        expect(self.page.get_by_text('重量としての計算結果', exact=False)).to_be_visible()

    def test_mass_scales_arithmetic_and_pressure(self):
        for expression, expected in [
            ('100cm * 1000g', '9.80665 N·m'),
            ('(1kg + 500g) * 2m', '29.41995 N·m'),
            ('1t * 1m', '9806.65 N·m'),
            ('-1kg * 1m', '-9.80665 N·m'),
            ('0kg * 1m', '0 N·m'),
            ('1kg / 1m^2', '9.80665 Pa'),
            ('1kg + 1kg', '19.6133 N'),
            ('1 / 1kg', '0.101972 1 / N'),
            ('1kg * 1m * 1m * 1m', '9.80665 m^3·N'),
            ('1kg + 1N', '10.80665 N'),
        ]:
            with self.subTest(expression=expression):
                self.input.fill(expression)
                expect(self.page.get_by_text(expected, exact=True)).to_be_visible()

    def test_existing_force_and_cancelled_mass_do_not_get_extra_gravity(self):
        for expression, expected in [
            ('1N * 1m', '1 J'),
            ('1kgf * 1m', '9.80665 J'),
            ('1kg / 1kg', '1'),
            ('1m + 1m', '2 m'),
        ]:
            with self.subTest(expression=expression):
                self.input.fill(expression)
                expect(self.page.get_by_text(expected, exact=True)).to_be_visible()
                expect(self.page.get_by_text('重量としての計算結果', exact=False)).to_have_count(0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
