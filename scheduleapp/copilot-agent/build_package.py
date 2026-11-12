"""Rebuild the Copilot setup ZIP and Word/text knowledge files using the standard library."""
from pathlib import Path
from xml.sax.saxutils import escape
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parent
XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
CONTENT_TYPES = XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
RELATIONSHIPS = XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'


def build():
    for path in ROOT.glob('*.md'):
        text = path.read_text()
        path.with_suffix('.txt').write_text(text)
        if path.stem not in ['knowledge', 'summary-procedure']:
            continue
        paragraphs = []
        for line in text.splitlines():
            heading = line.startswith('#')
            visible = line.lstrip('#').strip() if heading else line
            paragraphs.append('<w:p><w:r>' + ('<w:rPr><w:b/></w:rPr>' if heading else '') + '<w:t xml:space="preserve">' + escape(visible) + '</w:t></w:r></w:p>')
        document = XML + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + ''.join(paragraphs) + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>'
        with zipfile.ZipFile(path.with_suffix('.docx'), 'w', zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('[Content_Types].xml', CONTENT_TYPES)
            archive.writestr('_rels/.rels', RELATIONSHIPS)
            archive.writestr('word/document.xml', document)
        with zipfile.ZipFile(path.with_suffix('.docx')) as archive:
            assert archive.testzip() is None
            for name in archive.namelist():
                ET.fromstring(archive.read(name))
    package = ROOT / 'copilot-summary-agent.zip'
    with zipfile.ZipFile(package, 'w', zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(ROOT.iterdir()):
            if path.suffix in ['.md', '.txt', '.docx']:
                archive.write(path, path.name)
    with zipfile.ZipFile(package) as archive:
        assert archive.testzip() is None
        assert archive.read('instructions.txt').decode() == (ROOT / 'instructions.md').read_text()
        print(f'Built {package.name}: {len(archive.namelist())} files')


if __name__ == '__main__':
    build()
