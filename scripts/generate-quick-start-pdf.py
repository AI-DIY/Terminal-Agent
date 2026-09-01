#!/usr/bin/env python3
"""Create the standalone Windows quick-start PDF released with Terminal-Agent.

The repository's QuickStart.md is intentionally concise and links to images by
relative path.  Release assets need to work after download, so this small
generator embeds the same approved screenshots in a single PDF.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Image, KeepTogether, PageBreak, Paragraph, SimpleDocTemplate, Spacer
from reportlab.lib.utils import ImageReader


ROOT = Path(__file__).resolve().parents[1]
IMAGE_DIRECTORY = ROOT / "docs" / "images" / "quickstart"
REGULAR_FONT = "TerminalAgentYaHei"
BOLD_FONT = "TerminalAgentYaHeiBold"
WINDOWS_FONT_DIRECTORY = Path("C:/Windows/Fonts")


def application_version() -> str:
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    value = package.get("version")
    if not isinstance(value, str) or not value:
        raise RuntimeError("package.json is missing a release version")
    return value


def pdf_image(path: Path, maximum_width: float, maximum_height: float) -> Image:
    if not path.is_file():
        raise RuntimeError(f"Missing quick-start screenshot: {path}")
    reader = ImageReader(str(path))
    width, height = reader.getSize()
    if width <= 0 or height <= 0:
        raise RuntimeError(f"Invalid quick-start screenshot: {path}")
    scale = min(maximum_width / width, maximum_height / height)
    return Image(str(path), width=width * scale, height=height * scale)


def numbered_step(styles: dict[str, ParagraphStyle], title: str, body: str, screenshot: str) -> KeepTogether:
    image_path = IMAGE_DIRECTORY / screenshot
    return KeepTogether([
        Paragraph(title, styles["step"]),
        Paragraph(body, styles["body"]),
        Spacer(1, 0.14 * cm),
        pdf_image(image_path, 17.1 * cm, 10.2 * cm),
        Spacer(1, 0.34 * cm),
    ])


def build_pdf(output: Path) -> None:
    version = application_version()
    output.parent.mkdir(parents=True, exist_ok=True)
    regular_font_path = WINDOWS_FONT_DIRECTORY / "msyh.ttc"
    bold_font_path = WINDOWS_FONT_DIRECTORY / "msyhbd.ttc"
    if not regular_font_path.is_file() or not bold_font_path.is_file():
        raise RuntimeError("Microsoft YaHei fonts are required to generate the Windows quick-start PDF")
    pdfmetrics.registerFont(TTFont(REGULAR_FONT, str(regular_font_path), subfontIndex=0))
    pdfmetrics.registerFont(TTFont(BOLD_FONT, str(bold_font_path), subfontIndex=0))
    styles = getSampleStyleSheet()
    styles.add(ParagraphStyle(
        name="titleCn",
        parent=styles["Title"],
        fontName=BOLD_FONT,
        fontSize=24,
        leading=32,
        alignment=TA_CENTER,
        textColor=colors.HexColor("#15243b"),
        spaceAfter=0.55 * cm,
    ))
    styles.add(ParagraphStyle(
        name="subtitle",
        parent=styles["Normal"],
        fontName=REGULAR_FONT,
        fontSize=10.5,
        leading=17,
        alignment=TA_CENTER,
        textColor=colors.HexColor("#536273"),
        spaceAfter=0.7 * cm,
    ))
    styles.add(ParagraphStyle(
        name="intro",
        parent=styles["Normal"],
        fontName=REGULAR_FONT,
        fontSize=11.5,
        leading=19,
        textColor=colors.HexColor("#1f2937"),
        spaceAfter=0.45 * cm,
    ))
    styles.add(ParagraphStyle(
        name="step",
        parent=styles["Heading2"],
        fontName=BOLD_FONT,
        fontSize=15,
        leading=22,
        textColor=colors.HexColor("#0f4c81"),
        spaceBefore=0.24 * cm,
        spaceAfter=0.2 * cm,
    ))
    styles.add(ParagraphStyle(
        name="body",
        parent=styles["BodyText"],
        fontName=REGULAR_FONT,
        fontSize=10.5,
        leading=17,
        textColor=colors.HexColor("#27303b"),
        spaceAfter=0.12 * cm,
    ))
    styles.add(ParagraphStyle(
        name="code",
        parent=styles["Code"],
        fontName="Courier",
        fontSize=8.5,
        leading=13,
        backColor=colors.HexColor("#f1f5f9"),
        borderColor=colors.HexColor("#d8e0e8"),
        borderWidth=0.6,
        borderPadding=7,
        spaceAfter=0.28 * cm,
    ))
    styles.add(ParagraphStyle(
        name="footer",
        parent=styles["Normal"],
        fontName=REGULAR_FONT,
        fontSize=9,
        leading=15,
        textColor=colors.HexColor("#536273"),
        spaceBefore=0.45 * cm,
    ))

    document = SimpleDocTemplate(
        str(output),
        pagesize=A4,
        title=f"Terminal-Agent {version} 快速开始",
        author="AI-DIY",
        leftMargin=1.55 * cm,
        rightMargin=1.55 * cm,
        topMargin=1.35 * cm,
        bottomMargin=1.35 * cm,
    )

    story = [
        Paragraph("Terminal-Agent 快速开始", styles["titleCn"]),
        Paragraph(f"Windows / AccessClient 指引 · v{version}", styles["subtitle"]),
        Paragraph(
            "Terminal-Agent 是面向日常运维与企业堡垒机场景的 Windows SSH 工作台。"
            "请先安装应用，再将本 Release 附带的 putty.exe 中继程序放入 AccessClient 安装目录。",
            styles["intro"],
        ),
        numbered_step(
            styles,
            "1. 下载安装 Terminal-Agent",
            "在 GitHub Release 下载 <b>Terminal-Agent-Setup-x.x.x.exe</b>，并按安装向导完成安装。",
            "01-release-installer.png",
        ),
        PageBreak(),
        Paragraph("2. 获取 AccessClient 路径", styles["step"]),
        Paragraph("在 Windows 命令提示符或 PowerShell 中执行以下命令，查询 AccessClient 的安装路径。", styles["body"]),
        Paragraph('reg query "HKCR\\accessclient\\shell\\open\\command" /ve', styles["code"]),
        pdf_image(IMAGE_DIRECTORY / "02-find-accessclient-path.png", 17.1 * cm, 10.2 * cm),
        Spacer(1, 0.34 * cm),
        numbered_step(
            styles,
            "3. 备份 AccessClient 原文件",
            "在查询到的 AccessClient 目录中，将现有 <b>putty.exe</b> 重命名为 <b>putty.exe.bak</b>。保留备份以便需要时还原。",
            "03-backup-putty.png",
        ),
        PageBreak(),
        numbered_step(
            styles,
            "4. 复制 putty 中继程序到 AccessClient",
            "从同一个 GitHub Release 下载 <b>putty.exe</b>，复制到 AccessClient 目录中，使其替换原来的程序位置。",
            "04-download-putty-bridge.png",
        ),
        pdf_image(IMAGE_DIRECTORY / "05-copy-putty-bridge.png", 17.1 * cm, 10.2 * cm),
        Spacer(1, 0.34 * cm),
        PageBreak(),
        numbered_step(
            styles,
            "5. 在堡垒机中使用",
            "在堡垒机的“会话配置”中选择 <b>全局 putty</b>。之后按原有流程从堡垒机唤起 SSH 连接即可。",
            "06-select-global-putty.png",
        ),
        pdf_image(IMAGE_DIRECTORY / "07-launch-bastion.png", 17.1 * cm, 10.2 * cm),
        Paragraph(
            "提示：只需映射 Release 随附的 putty.exe。Terminal-Agent 主程序由安装包安装，"
            "不要将整个应用目录复制到 AccessClient 目录。",
            styles["footer"],
        ),
    ]
    document.build(story)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate the Terminal-Agent standalone quick-start PDF")
    parser.add_argument("--output", type=Path, default=ROOT / "release" / "quick-start.pdf")
    args = parser.parse_args()
    build_pdf(args.output.resolve())
    print(args.output.resolve())


if __name__ == "__main__":
    main()
