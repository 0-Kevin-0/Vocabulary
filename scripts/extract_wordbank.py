import json
import re
from pathlib import Path

from rapidocr_onnxruntime import RapidOCR


PROJECT_DIR = Path(r"E:\Files\Works\Site\En-trainning")
WORDPIC_DIR = PROJECT_DIR / "wordpic"
ASSETS_DIR = Path(
    r"C:\Users\asus\.cursor\projects\e-Files-Works-Site-En-trainning\assets"
)

OCR_FIXES = {
    "dangcrous": "dangerous",
    "zinb": "",
}

FORCE_CASE_MAP = {
    "africa": "Africa",
    "african": "African",
    "america": "America",
    "american": "American",
    "antarctic": "Antarctic",
    "antarctica": "Antarctica",
    "april": "April",
    "arab": "Arab",
    "arabic": "Arabic",
    "arctic": "Arctic",
    "asia": "Asia",
    "asian": "Asian",
    "atlantic": "Atlantic",
    "australia": "Australia",
    "australian": "Australian",
    "bc": "BC",
    "britain": "Britain",
    "british": "British",
    "canada": "Canada",
    "canadian": "Canadian",
    "cd": "CD",
    "cd-rom": "CD-ROM",
    "coca-cola": "Coca-Cola",
    "confucian": "Confucian",
    "december": "December",
    "dna": "DNA",
    "dvd": "DVD",
    "egypt": "Egypt",
    "egyptian": "Egyptian",
    "england": "England",
    "english": "English",
    "europe": "Europe",
    "european": "European",
    "february": "February",
    "france": "France",
    "french": "French",
    "friday": "Friday",
    "german": "German",
    "germany": "Germany",
    "greece": "Greece",
    "greek": "Greek",
    "hiv": "HIV",
    "i": "I",
    "iceland": "Iceland",
    "x-ray": "X-ray",
    "t-shirt": "T-shirt",
    "wednesday": "Wednesday",
    "zoo": "zoo",
}


def normalize_token(token: str) -> str:
    token = token.strip()
    token = token.replace("’", "'").replace("‘", "'")
    token = token.replace("–", "-").replace("—", "-")
    token = re.sub(r"\s+", " ", token)
    token = token.strip(".,;:")
    return token


def clean_word(word: str) -> str:
    item = normalize_token(word)
    if not item:
        return ""
    low = item.lower()
    if low in OCR_FIXES:
        item = OCR_FIXES[low]
        if not item:
            return ""
        low = item.lower()
    if low in FORCE_CASE_MAP:
        return FORCE_CASE_MAP[low]
    return item


def parse_words(text: str) -> list[str]:
    words: list[str] = []
    for line in text.splitlines():
        item = normalize_token(line)
        if not item:
            continue
        if re.search(r"[A-Za-z]", item):
            if re.search(r"\d", item):
                continue
            if not re.fullmatch(r"[A-Za-z()/' .-]+", item):
                continue
            cleaned = clean_word(item)
            if cleaned:
                words.append(cleaned)
    return words


def load_existing_words(path: Path) -> list[str]:
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        words = data.get("words", [])
        if isinstance(words, list):
            cleaned: list[str] = []
            for w in words:
                if not isinstance(w, str):
                    continue
                item = clean_word(w)
                if not item:
                    continue
                if not re.search(r"[A-Za-z]", item):
                    continue
                if re.search(r"\d", item):
                    continue
                if not re.fullmatch(r"[A-Za-z()/' .-]+", item):
                    continue
                cleaned.append(item)
            return cleaned
    except Exception:
        return []
    return []


def ocr_image(engine: RapidOCR, path: Path) -> str:
    result, _ = engine(str(path), det=True, cls=False, rec=True)
    if not result:
        return ""
    lines = [item[1] for item in result if len(item) > 1 and item[1]]
    return "\n".join(lines)


def main() -> None:
    PROJECT_DIR.mkdir(parents=True, exist_ok=True)
    image_paths = sorted(
        list(WORDPIC_DIR.glob("*.png"))
        + list(WORDPIC_DIR.glob("*.jpg"))
        + list(WORDPIC_DIR.glob("*.jpeg"))
        + list(ASSETS_DIR.glob("*.png"))
        + list(ASSETS_DIR.glob("*.jpg"))
        + list(ASSETS_DIR.glob("*.jpeg"))
    )
    engine = RapidOCR()

    json_path = PROJECT_DIR / "wordbank.json"
    txt_path = PROJECT_DIR / "wordbank.txt"

    all_words: list[str] = []
    for image_path in image_paths:
        text = ocr_image(engine, image_path)
        words = parse_words(text)
        all_words.extend(words)

    dedup_map: dict[str, str] = {}
    for w in all_words:
        item = clean_word(w)
        if not item:
            continue
        key = item.lower()
        if key not in dedup_map:
            dedup_map[key] = item
    unique_words = [dedup_map[k] for k in sorted(dedup_map.keys())]

    txt_path.write_text("\n".join(unique_words) + "\n", encoding="utf-8")
    json_path.write_text(
        json.dumps({"count": len(unique_words), "words": unique_words}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print(f"images: {len(image_paths)}")
    print(f"words: {len(unique_words)}")
    print(f"txt: {txt_path}")
    print(f"json: {json_path}")


if __name__ == "__main__":
    main()
