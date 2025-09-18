import os
import zipfile

zip_filename = "EntechChat.zip"

files_content = {
    "server.js": open("server.js", "r", encoding="utf-8").read(),
    "widget.html": open("widget.html", "r", encoding="utf-8").read(),
    "excel_to_json.py": open("excel_to_json.py", "r", encoding="utf-8").read(),
    "extract_full_kp.py": open("extract_full_kp.py", "r", encoding="utf-8").read(),
    "scenario.json": open("scenario.json", "r", encoding="utf-8").read(),
    "package.json": """\
{
  "name": "entech-widget",
  "version": "1.2.0",
  "description": "AI sales widget for Entech LED lighting",
  "main": "server.js",
  "type": "module",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js",
    "test": "jest"
  },
  "dependencies": {
    "cors": "^2.8.5",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "helmet": "^7.1.0",
    "express-rate-limit": "^7.4.0",
    "node-cache": "^5.1.2",
    "winston": "^3.14.2",
    "openai": "^4.59.0"
  },
  "devDependencies": {
    "nodemon": "^3.1.7",
    "jest": "^29.7.0"
  }
}
""",
    ".env.example": """\
OPENAI_API_KEY=sk-YOUR_KEY
OPENAI_MODEL=gpt-4o-mini
ALLOWED_ORIGINS=https://ene-rgy.ru,https://yourproject.tilda.ws
""",
    "requirements.txt": """\
openpyxl==3.1.5
pdfplumber==0.11.4
reportlab==4.2.2
Pillow==10.4.0
""",
    "quotes.json": "[]"
}

with zipfile.ZipFile(zip_filename, "w") as zipf:
    for filename, content in files_content.items():
        zipf.writestr(filename, content)
    # Add sample Excel
    if os.path.exists("ПРАЙС ЛИСТ ЭНТЕХ от 31.08.23.xlsx"):
        zipf.write("ПРАЙС ЛИСТ ЭНТЕХ от 31.08.23.xlsx")

print(f"ZIP created: {zip_filename}")