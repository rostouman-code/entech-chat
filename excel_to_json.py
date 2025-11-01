#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
excel_to_json.py
Парсит прайс из Excel -> catalog.json

Ключевые правки:
- Нормализация чисел с пробелами (например, "5 700 лм" -> 5700)
- Аккуратное извлечение мощности (Вт) и светового потока (лм)
- Мягкая обработка пропусков и мусора
"""

import json
import re
import sys
from pathlib import Path

import pandas as pd

# === Настройки ===
# По умолчанию берём файл из репозитория
DEFAULT_XLSX = Path(__file__).with_name("ПРАЙС ЛИСТ ЭНТЕХ от 31.08.23.xlsx")
OUTPUT_JSON = Path(__file__).with_name("catalog.json")

# Если известны явные названия столбцов, можно указать здесь:
COLUMNS_HINTS = {
    "model": ["Модель", "Наименование", "Model", "Название", "Артикул"],
    "description": ["Описание", "Описание / ТТХ", "Description", "Характеристики"],
    "power": ["Мощность", "Power", "Вт"],
    "lumens": ["Световой поток", "Lumens", "лм"],
    "ip": ["Степень защиты", "IP", "IP rating"],
    "beam": ["Угол", "Угол светораспределения", "Beam", "Угол, град"],
    "category": ["Категория", "Назначение", "Сфера применения"],
    "image": ["Фото", "Изображение", "Image", "Картинка", "IMG"]
}

# === Хелперы парсинга ===
def parse_int_with_unit(txt: str, unit_regex: str):
    """
    Ищет число (с пробелами/неразрывными пробелами/возможной запятой) перед единицей,
    например: r'(лм|lm)\\b' или r'(вт|w)\\b'.
    Возвращает int или None.
    """
    if not txt:
        return None
    t = str(txt)
    # удалить HTML-переводы строк и т.п.
    t = t.replace("\n", " ").replace("\r", " ")
    # поиск числа (включая пробелы внутри)
    m = re.search(r'(\d[\d\s\u00A0,]{0,12})\s*' + unit_regex, t, flags=re.I)
    if not m:
        return None
    raw = m.group(1)
    raw = raw.replace("\u00A0", " ").replace(" ", "")  # убрать пробелы, в т.ч. неразрывные
    raw = raw.replace(",", "")  # на всякий случай "5,700"
    try:
        return int(raw)
    except Exception:
        return None


def coalesce(*vals):
    for v in vals:
        if v is not None and v != "":
            return v
    return None


def normalize_str(x):
    if x is None:
        return None
    s = str(x).strip()
    return s if s else None


def find_first_col(df_cols, aliases):
    """
    Находит первый подходящий столбец из списка псевдонимов.
    """
    low = {c.lower(): c for c in df_cols}
    for alias in aliases:
        a = alias.lower()
        if a in low:
            return low[a]
    # иногда названия колонок могут содержать алиасы как часть
    for c in df_cols:
        for alias in aliases:
            if alias.lower() in c.lower():
                return c
    return None


def deduce_category(text):
    """
    Пытаемся понять категорию по описанию/названию.
    """
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


def extract_power_and_lumens(row, desc_col):
    """
    Унифицированный способ извлечения мощности/люменов:
    - сначала пробуем явные колонки power/lumens,
    - затем пытаемся вытащить из колонки-описания с помощью regex.
    """
    # 1) из явных колонок, если есть
    pow_raw = None
    lum_raw = None

    for key, aliases in [("power", COLUMNS_HINTS["power"]), ("lumens", COLUMNS_HINTS["lumens"])]:
        col = find_first_col(row.index, aliases)
        if col:
            val = row.get(col)
            try:
                if key == "power":
                    pow_raw = int(str(val).replace(" ", "").replace("\u00A0", ""))
                else:
                    lum_raw = int(str(val).replace(" ", "").replace("\u00A0", ""))
            except Exception:
                pass

    # 2) из описания
    desc = row.get(desc_col) if desc_col else None
    desc_str = str(desc) if desc is not None else ""

    power_w = coalesce(
        pow_raw,
        parse_int_with_unit(desc_str, r'(вт|w)\b')
    )
    lumens = coalesce(
        lum_raw,
        parse_int_with_unit(desc_str, r'(лм|lm)\b')
    )

    return power_w, lumens


def extract_ip_and_beam(row, desc_col):
    desc = row.get(desc_col) if desc_col else None
    desc_str = str(desc) if desc is not None else ""

    # IP: ищем "IP20", "IP65"
    m_ip = re.search(r'\b(ip)\s*([0-9]{2})\b', desc_str, flags=re.I)
    ip_rating = None
    if m_ip:
        ip_rating = "IP" + m_ip.group(2)

    # Угол, градусы
    beam_angle = None
    # Например "угол 90°", "угол 60", "Beam 120"
    m_beam = re.search(r'(угол|beam)[^\d]{0,5}(\d{2,3})', desc_str, flags=re.I)
    if m_beam:
        try:
            beam_angle = int(m_beam.group(2))
        except Exception:
            beam_angle = None

    return ip_rating, beam_angle


def main(xlsx_path=None, out_path=None):
    xlsx = Path(xlsx_path) if xlsx_path else DEFAULT_XLSX
    out = Path(out_path) if out_path else OUTPUT_JSON

    if not xlsx.exists():
        print(f"[ERROR] Файл не найден: {xlsx}", file=sys.stderr)
        sys.exit(1)

    # загрузка
    try:
        df = pd.read_excel(xlsx, header=0)
    except Exception as e:
        print(f"[ERROR] Не удалось прочитать Excel: {e}", file=sys.stderr)
        sys.exit(1)

    df = df.fillna("")

    # определение колонок
    model_col = find_first_col(df.columns, COLUMNS_HINTS["model"])
    desc_col = find_first_col(df.columns, COLUMNS_HINTS["description"])
    ip_col = find_first_col(df.columns, COLUMNS_HINTS["ip"])
    beam_col = find_first_col(df.columns, COLUMNS_HINTS["beam"])
    cat_col = find_first_col(df.columns, COLUMNS_HINTS["category"])
    image_col = find_first_col(df.columns, COLUMNS_HINTS["image"])

    items = []
    for _, row in df.iterrows():
        model = normalize_str(row.get(model_col)) if model_col else None
        if not model:
            # пропускаем пустые строки
            continue

        description = normalize_str(row.get(desc_col)) if desc_col else None

        # мощность/люмены
        power_w, lumens = extract_power_and_lumens(row, desc_col)

        # IP/угол
        ip_rating = None
        if ip_col:
            ip_rating = normalize_str(row.get(ip_col))
            # нормализуем формат IP
            if ip_rating and re.search(r'\bip\s*([0-9]{2})\b', ip_rating, flags=re.I):
                ip_rating = "IP" + re.search(r'\bip\s*([0-9]{2})\b', ip_rating, flags=re.I).group(1)
        else:
            ip_rating, _beam_dummy = extract_ip_and_beam(row, desc_col)

        beam_angle = None
        if beam_col:
            try:
                beam_angle = int(str(row.get(beam_col)).strip().replace("°", ""))
            except Exception:
                # fallback на описание
                _, beam_angle = extract_ip_and_beam(row, desc_col)
        else:
            _, beam_angle = extract_ip_and_beam(row, desc_col)

        # категория
        category = None
        if cat_col:
            category = normalize_str(row.get(cat_col))
            # привести к «нашим» ярлыкам
            category = deduce_category(category) or category
        else:
            category = deduce_category((model or "") + " " + (description or ""))

        # картинка
        image_url = normalize_str(row.get(image_col)) if image_col else None

        item = {
            "id": f"excel-{len(items)+1}",
            "model": model,
            "description": description,
            "power_w": power_w,
            "lumens": lumens,
            "ip_rating": ip_rating,
            "beam_angle": beam_angle,
            "category": category,
            "image_url": image_url
        }
        items.append(item)

    # фильтр на совсем пустые
    items = [x for x in items if x.get("model")]

    # сохранение
    with open(out, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)

    print(f"[OK] Сохранено {len(items)} записей в {out}")


if __name__ == "__main__":
    # Можно вызывать:
    # python excel_to_json.py
    # python excel_to_json.py input.xlsx output.json
    argv = sys.argv[1:]
    xlsx_path = argv[0] if len(argv) >= 1 else None
    out_path = argv[1] if len(argv) >= 2 else None
    main(xlsx_path, out_path)
