import openpyxl
from reportlab.lib.pagesizes import A4
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Image, Table, TableStyle
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
import io
from PIL import Image as PILImage

EXCEL_FILE = "ПРАЙС ЛИСТ ЭНТЕХ от 31.08.23.xlsx"
MODEL_NAME = "NRG-TRADE-20-1000"
OUTPUT_PNG = "temp.png"
OUTPUT_PDF = "result_kp.pdf"

pdfmetrics.registerFont(TTFont('DejaVu', 'DejaVuSans.ttf'))

def extract_product_data(filename, model_name):
    wb = openpyxl.load_workbook(filename, data_only=True)
    ws = wb.active

    target_row = None
    row_data = None

    for row in ws.iter_rows(min_row=2, values_only=False):
        for cell in row:
            if cell.value and model_name in str(cell.value):
                target_row = cell.row
                row_data = [c.value for c in row]
                break
        if target_row:
            break

    if not target_row:
        raise ValueError(f"Модель {model_name} не найдена")

    img_path = None
    for img in ws._images:
        if hasattr(img.anchor, "_from") and img.anchor._from.row + 1 == target_row:
            pil_img = PILImage.open(io.BytesIO(img._data()))
            pil_img.save(OUTPUT_PNG)
            img_path = OUTPUT_PNG
            break

    return row_data, img_path

def create_pdf(model_name, row_data, image_path, output_file):
    doc = SimpleDocTemplate(output_file, pagesize=A4)
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(name="Russian", fontName="DejaVu", fontSize=10))

    story = []

    story.append(Paragraph(f"Коммерческое предложение: {model_name}", styles["Title"]))
    story.append(Spacer(1, 20))

    if image_path:
        story.append(Image(image_path, width=250, height=180))
        story.append(Spacer(1, 20))

    headers = ["Модель", "Мощность", "Световой поток", "Цветовая температура", "IP", "Гарантия"]
    values = [str(v) if v is not None else "-" for v in row_data[:len(headers)]]

    table_data = [headers, values]

    col_widths = []
    for col in zip(*table_data):
        max_len = max(len(str(x)) for x in col)
        col_widths.append(max(60, min(120, max_len * 5)))

    table = Table(table_data, colWidths=col_widths, hAlign="LEFT")
    table.setStyle(TableStyle([
        ('BACKGROUND', (0,0), (-1,0), colors.lightgrey),
        ('TEXTCOLOR', (0,0), (-1,0), colors.black),
        ('ALIGN', (0,0), (-1,-1), 'CENTER'),
        ('FONTNAME', (0,0), (-1,-1), 'DejaVu'),
        ('FONTSIZE', (0,0), (-1,-1), 9),
        ('BOTTOMPADDING', (0,0), (-1,0), 8),
        ('GRID', (0,0), (-1,-1), 0.5, colors.black),
    ]))

    story.append(table)
    story.append(Spacer(1, 20))
    story.append(Paragraph("Для расчёта стоимости и условий поставки свяжитесь с нашим менеджером.", styles["Russian"]))

    doc.build(story)

if __name__ == "__main__":
    row_data, img_path = extract_product_data(EXCEL_FILE, MODEL_NAME)
    create_pdf(MODEL_NAME, row_data, img_path, OUTPUT_PDF)
    print(f"PDF создан: {OUTPUT_PDF}")