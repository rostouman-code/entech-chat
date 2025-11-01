#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
pdf_to_json.py
Извлекает позиции из PDF (текстового) -> catalog.json

Ключевые правки:
- Нормализация чисел с пробелами (например, "12 000 лм" -> 12000)
- Аккуратные regex для мощности (Вт) и светового потока (лм)
- Пытаемся поймать IP и угол
"""

import json
import re
import sys
from pathlib import Path

try:
    # pdfminer.six рекомендуется для извлечения текста
    from pdfminer.high_level import extract_text
except Exception:
    extract_text = None
    # Если нет pdfminer, предупредим, но дадим возможность упасть красиво.

OUTPUT_JSON = Path(__file__).with_name("catalog.json")

def parse_int_with_unit(txt: str, unit_regex: str):
    if not txt:
        return None
    t = str(txt).replace("\n", " ").replace("\r", " ")
    m = re.search(r'(\d[\d\s\u00A0,]{0,12})\s*' + unit_regex, t, flags=re.I)
    if not m:
        return None
    raw = m.group(1)
    raw = raw.replace("\u00A0", " ").replace(" ", "")
    raw = raw.replace(",", "")
    try:
        return int(raw)
    except Exception:
        return None

def deduce_category(text):
    if not text:
        return None
    t = text.lower()
    if any(x in t for x in ["офис", "админ", "торгов", "офисный"]):
        return "office"
    if any(x in t for x in ["склад", "логист", "ангары", "паллет"]):
        return "warehouse"
    if any(x in t for x in ["цех", "цеховой", "производ", "индустри"]):
        return "workshop"
    if any(x in t for x in ["улиц", "наруж", "дорож", "фасад", "территор"]):
        return "street"
    return None

def extract_ip_and_beam(text):
    t = text or ""
    ip_rating = None
    m_ip = re.search(r'\b(ip)\s*([0-9]{2})\b', t, flags=re.I)
    if m_ip:
        ip_rating = "IP" + m_ip.group(2)

    beam_angle = None
    m_beam = re.search(r'(угол|beam)[^\d]{0,5}(\d{2,3})', t, flags=re.I)
    if m_beam:
        try:
            beam_angle = int(m_beam.group(2))
        except Exception:
            beam_angle = None

    return ip_rating, beam_angle

def split_lines_to_items(text):
    """
    Очень грубый разбор по строкам:
    Ищем блоки, похожие на карточки товара: строка с названием/моделью,
    рядом/следом характеристики.
    Под конкретный PDF при необходимости подкрутить.
    """
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    items = []

    buff = []
    def flush():
        if not buff:
            return
        blob = " ".join(buff)
        model = None

        # эвристика модели: слово с латиницей+цифрами/рус+цифры длиной >3
        mm = re.search(r'([A-ZА-Я0-9][A-ZА-Я0-9\-\_\.]{2,})', blob, flags=re.I)
        if mm:
            model = mm.group(1)

        power_w = parse_int_with_unit(blob, r'(вт|w)\b')
        lumens  = parse_int_with_unit(blob, r'(лм|lm)\b')
        ip, beam = extract_ip_and_beam(blob)
        cat = deduce_category(blob)

        if model:
            items.append({
                "id": f"pdf-{len(items)+1}",
                "model": model,
                "description": blob[:4000],
                "power_w": power_w,
                "lumens": lumens,
                "ip_rating": ip,
                "beam_angle": beam,
                "category": cat,
                "image_url": None
            })

        buff.clear()

    # очень простой разбор: каждые 3-6 строк — один товар
    for line in lines:
        buff.append(line)
        if len(buff) >= 5:
            flush()
    flush()
    return items

def main(pdf_path, out_path=None):
    if extract_text is None:
        print("[ERROR] Установите pdfminer.six: pip install pdfminer.six", file=sys.stderr)
        sys.exit(1)

    pdf = Path(pdf_path)
    out = Path(out_path) if out_path else OUTPUT_JSON

    if not pdf.exists():
        print(f"[ERROR] Файл не найден: {pdf}", file=sys.stderr)
        sys.exit(1)

    try:
        text = extract_text(str(pdf))
    except Exception as e:
        print(f"[ERROR] Не удалось извлечь текст из PDF: {e}", file=sys.stderr)
        sys.exit(1)

    items = split_lines_to_items(text)

    with open(out, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)

    print(f"[OK] Сохранено {len(items)} записей в {out}")

if __name__ == "__main__":
    # Использование:
    # python pdf_to_json.py input.pdf
    # python pdf_to_json.py input.pdf output.json
    argv = sys.argv[1:]
    if not argv:
        print("Укажите путь к PDF, например:\n  python pdf_to_json.py katalog.pdf", file=sys.stderr)
        sys.exit(1)
    pdf_path = argv[0]
    out_path = argv[1] if len(argv) >= 2 else None
    main(pdf_path, out_path)
