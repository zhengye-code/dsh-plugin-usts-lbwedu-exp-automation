"""Extract text (and optionally page images) from a PDF with PyMuPDF.

Called by lib/pdf.js as:

    python -X utf8 scripts/pdf.py <base64 JSON options>

Options:
    path      PDF file path (required)
    pages     page selection such as "1-3,7" (1-based); all pages when absent
    render    true to render the selected pages as PNG
    renderDir directory for rendered PNG files
    dpi       render resolution (default 150)

Prints exactly one JSON object. This file stays ASCII-only; the extracted text
is emitted as UTF-8 JSON.
"""
import base64
import json
import os
import sys

MAX_DEFAULT_PAGES = 40


def fail(message, code=2):
    sys.stdout.write(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
    sys.exit(code)


def parse_selection(spec, page_count):
    if not spec:
        pages = list(range(page_count))
        truncated = page_count > MAX_DEFAULT_PAGES
        if truncated:
            pages = pages[:MAX_DEFAULT_PAGES]
        return pages, truncated
    selected = []
    for part in str(spec).split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            start_text, end_text = part.split("-", 1)
            start = int(start_text)
            end = int(end_text)
        else:
            start = end = int(part)
        if start < 1 or end < start:
            raise ValueError("invalid page range: %s" % part)
        for page in range(start, end + 1):
            if page > page_count:
                raise ValueError("page %d is beyond the document (%d pages)" % (page, page_count))
            selected.append(page - 1)
    unique = []
    for page in selected:
        if page not in unique:
            unique.append(page)
    return unique, False


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    if len(sys.argv) < 2:
        fail("pdf.py expects a base64 JSON payload")
    try:
        options = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))
    except Exception as error:  # noqa: BLE001 - report the payload problem verbatim
        fail("cannot decode payload: %s" % error)

    path = options.get("path")
    if not path:
        fail("a PDF path is required")
    if not os.path.isfile(path):
        fail("PDF not found: %s" % path)

    try:
        import pymupdf
    except Exception:  # noqa: BLE001 - fall back to the legacy module name
        try:
            import fitz as pymupdf
        except Exception as error:  # noqa: BLE001
            fail("PyMuPDF is not installed for this Python (%s)" % error)

    try:
        document = pymupdf.open(path)
    except Exception as error:  # noqa: BLE001
        fail("cannot open PDF: %s" % error)

    try:
        pages, truncated = parse_selection(options.get("pages"), document.page_count)
    except ValueError as error:
        fail(str(error))
    render = bool(options.get("render"))
    render_dir = options.get("renderDir")
    if render and not render_dir:
        fail("render requires renderDir")
    if render and not os.path.isdir(render_dir):
        os.makedirs(render_dir, exist_ok=True)
    dpi = int(options.get("dpi") or 150)

    result = {
        "ok": True,
        "path": os.path.abspath(path),
        "pageCount": document.page_count,
        "selected": [page + 1 for page in pages],
        "truncated": truncated,
        "pages": [],
        "rendered": [],
    }
    for page_index in pages:
        page = document.load_page(page_index)
        text = page.get_text()
        result["pages"].append({"page": page_index + 1, "chars": len(text), "text": text})
        if render:
            stem = os.path.splitext(os.path.basename(path))[0]
            target = os.path.join(render_dir, "%s_p%02d.png" % (stem, page_index + 1))
            pixmap = page.get_pixmap(dpi=dpi)
            pixmap.save(target)
            result["rendered"].append({"page": page_index + 1, "path": target, "width": pixmap.width, "height": pixmap.height})

    sys.stdout.write(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
