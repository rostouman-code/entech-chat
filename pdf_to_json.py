import pdfplumber
import json
import re

def parse_line(line):
    """
    Парсим строку из каталога: модель, мощность, люмены, IP-защита, категория, размеры, вес, гарантия.
    Пример: 'Промышленный светильник ENTECH PRO 100Вт 12000лм IP65 600x200x100мм 5кг Гарантия 5 лет'
    """

    # Мощность (Вт)
    power_match = re.search(r'(\d+)\s?(Вт|W)', line, re.IGNORECASE)
    power = int(power_match.group(1)) if power_match else None

    # Световой поток (лм)
    lumen_match = re.search(r'(\d+)\s?(лм|lm)', line, re.IGNORECASE)
    lumens = int(lumen_match.group(1)) if lumen_match else None

    # IP-защита
    ip_match = re.search(r'(IP\d{2})', line, re.IGNORECASE)
    ip_rating = ip_match.group(1).upper() if ip_match else None

    # Категория
    categories = ["промышленный", "уличный", "офисный", "спортивный", "взрывозащищенный", "прожектор"]
    category = None
    for cat in categories:
        if cat.lower() in line.lower():
            category = cat
            break

    # Модель (ищем ENTECH …)
    model_match = re.search(r'(ENTECH[^\s,]*)', line, re.IGNORECASE)
    model = model_match.group(1) if model_match else None

    # Размеры (например: 600x200x100 мм или 600×200×100 mm)
    size_match = re.search(r'(\d+)[x×](\d+)[x×](\d+)\s?(мм|mm)', line, re.IGNORECASE)
    dimensions = {
        "length_mm": int(size_match.group(1)),
        "width_mm": int(size_match.group(2)),
        "height_mm": int(size_match.group(3))
    } if size_match else None

    # Вес (например: 5кг, 12.5 kg)
    weight_match = re.search(r'(\d+([.,]\d+)?)\s?(кг|kg)', line, re.IGNORECASE)
    weight_kg = float(weight_match.group(1).replace(",", ".")) if weight_match else None

    # Гарантия (например: 5 лет, 3 года)
    warranty_match = re.search(r'(\d+)\s?(лет|года|г.)', line, re.IGNORECASE)
    warranty_years = int(warranty_match.group(1)) if warranty_match else None

    return {
        "raw": line.strip(),
        "model": model,
        "power_w": power,
        "lumens": lumens,
        "ip_rating": ip_rating,
        "category": category,
        "dimensions_mm": dimensions,
        "weight_kg": weight_kg,
        "warranty_years": warranty_years
    }

def pdf_to_json(pdf_path, json_path):
    catalog = []

    with pdfplumber.open(pdf_path) as pdf:
        for page in pdf.pages:
            text = page.extract_text()
            if not text:
                continue

            lines = text.split("\n")
            for line in lines:
                # добавляем только строки с мощностью, люменами или IP
                if re.search(r'(Вт|W|лм|lm|IP\d{2})', line, re.IGNORECASE):
                    item = parse_line(line)
                    catalog.append(item)

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(catalog, f, ensure_ascii=False, indent=2)

    print(f"Сохранено {len(catalog)} товаров в {json_path}")

if __name__ == "__main__":
    pdf_to_json("catalog.pdf", "catalog.json")
