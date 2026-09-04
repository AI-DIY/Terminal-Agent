#!/usr/bin/env python3
"""Generate the standalone Windows quick-install guide for a release.

The old QuickStart document described four manual file operations. Starting
with v3.2.0 those operations are performed by the ZIP's quick-install script;
this document explains the self-contained ZIP flow and leaves only the vendor
AccessClient setting as a manual step.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import BaseDocTemplate, Frame, Image, PageBreak, PageTemplate, Paragraph, Spacer, Table, TableStyle
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


def image_or_none(path: Path, maximum_width: float, maximum_height: float) -> Image | None:
    if not path.is_file():
        return None
    reader = ImageReader(str(path))
    width, height = reader.getSize()
    if width <= 0 or height <= 0:
        return None
    scale = min(maximum_width / width, maximum_height / height)
    return Image(str(path), width=width * scale, height=height * scale)


def make_styles() -> dict[str, ParagraphStyle]:
    sample = getSampleStyleSheet()
    common = dict(wordWrap="CJK")
    return {
        "title": ParagraphStyle("guideTitle", parent=sample["Title"], **common, fontName=BOLD_FONT, fontSize=25, leading=33, alignment=TA_CENTER, textColor=colors.HexColor("#24133d"), spaceAfter=0.25 * cm),
        "subtitle": ParagraphStyle("guideSubtitle", parent=sample["Normal"], **common, fontSize=10.5, leading=17, alignment=TA_CENTER, textColor=colors.HexColor("#6c5b7b"), spaceAfter=0.65 * cm),
        "lead": ParagraphStyle("guideLead", parent=sample["BodyText"], **common, fontName=REGULAR_FONT, fontSize=11.5, leading=19, textColor=colors.HexColor("#263241"), spaceAfter=0.35 * cm),
        "heading": ParagraphStyle("guideHeading", parent=sample["Heading2"], **common, fontName=BOLD_FONT, fontSize=16, leading=23, textColor=colors.HexColor("#4d2d76"), spaceBefore=0.18 * cm, spaceAfter=0.18 * cm),
        "stepHeading": ParagraphStyle("guideStepHeading", parent=sample["Heading3"], **common, fontName=BOLD_FONT, fontSize=12.5, leading=18, textColor=colors.HexColor("#392253"), spaceAfter=0.08 * cm),
        "body": ParagraphStyle("guideBody", parent=sample["BodyText"], **common, fontName=REGULAR_FONT, fontSize=10.5, leading=17, textColor=colors.HexColor("#263241"), spaceAfter=0.12 * cm),
        "small": ParagraphStyle("guideSmall", parent=sample["BodyText"], **common, fontName=REGULAR_FONT, fontSize=9.2, leading=14, textColor=colors.HexColor("#5d6876")),
        "code": ParagraphStyle("guideCode", parent=sample["Code"], fontName=REGULAR_FONT, fontSize=9.5, leading=14, textColor=colors.HexColor("#263241"), backColor=colors.HexColor("#f2eef8"), borderColor=colors.HexColor("#d9cce8"), borderWidth=0.6, borderPadding=7, spaceAfter=0.2 * cm),
        "callout": ParagraphStyle("guideCallout", parent=sample["BodyText"], **common, fontName=REGULAR_FONT, fontSize=10.2, leading=16, textColor=colors.HexColor("#49316a")),
        "footer": ParagraphStyle("guideFooter", parent=sample["Normal"], **common, fontName=REGULAR_FONT, fontSize=8.5, leading=12, alignment=TA_CENTER, textColor=colors.HexColor("#7b8490")),
    }


def card(number: str, title: str, body: str, styles: dict[str, ParagraphStyle]) -> Table:
    badge_style = ParagraphStyle(f"badge{number}", parent=styles["body"], fontName=BOLD_FONT, fontSize=14, leading=18, alignment=TA_CENTER, textColor=colors.white)
    badge = Table([[Paragraph(f"<b>{number}</b>", badge_style)]], colWidths=[0.78 * cm], rowHeights=[0.78 * cm])
    badge.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#7047a1")), ("VALIGN", (0, 0), (-1, -1), "MIDDLE")]))
    content = [Paragraph(title, styles["stepHeading"]), Paragraph(body, styles["body"])]
    table = Table([[badge, content]], colWidths=[1.05 * cm, 15.95 * cm], hAlign="LEFT")
    table.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 10), ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 10), ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#faf8fd")),
        ("BOX", (0, 0), (-1, -1), 0.7, colors.HexColor("#ded2ec")),
    ]))
    return table


def callout(text: str, styles: dict[str, ParagraphStyle], background: str = "#f2eafa", border: str = "#8c68b3") -> Table:
    table = Table([[Paragraph(text, styles["callout"])]], colWidths=[17.0 * cm])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor(background)),
        ("BOX", (0, 0), (-1, -1), 0.8, colors.HexColor(border)),
        ("LINEBEFORE", (0, 0), (0, 0), 3, colors.HexColor(border)),
        ("LEFTPADDING", (0, 0), (-1, -1), 11), ("RIGHTPADDING", (0, 0), (-1, -1), 11),
        ("TOPPADDING", (0, 0), (-1, -1), 9), ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
    ]))
    return table


def draw_footer(canvas, document) -> None:  # type: ignore[no-untyped-def]
    canvas.saveState()
    width, _height = A4
    canvas.setStrokeColor(colors.HexColor("#e3dbea"))
    canvas.setLineWidth(0.5)
    canvas.line(document.leftMargin, 1.02 * cm, width - document.rightMargin, 1.02 * cm)
    canvas.setFont(REGULAR_FONT, 8.5)
    canvas.setFillColor(colors.HexColor("#7b8490"))
    canvas.drawCentredString(width / 2, 0.64 * cm, f"Terminal-Agent v{application_version()}  -  快速安装手册  -  第 {canvas.getPageNumber()} 页")
    canvas.restoreState()


def build_pdf(output: Path) -> None:
    version = application_version()
    output.parent.mkdir(parents=True, exist_ok=True)
    regular_font_path = WINDOWS_FONT_DIRECTORY / "msyh.ttc"
    bold_font_path = WINDOWS_FONT_DIRECTORY / "msyhbd.ttc"
    if not regular_font_path.is_file() or not bold_font_path.is_file():
        raise RuntimeError("Microsoft YaHei fonts are required to generate the Windows quick-start PDF")
    pdfmetrics.registerFont(TTFont(REGULAR_FONT, str(regular_font_path), subfontIndex=0))
    pdfmetrics.registerFont(TTFont(BOLD_FONT, str(bold_font_path), subfontIndex=0))
    styles = make_styles()

    document = BaseDocTemplate(str(output), pagesize=A4, title=f"Terminal-Agent {version} 快速安装手册", author="AI-DIY", leftMargin=1.6 * cm, rightMargin=1.6 * cm, topMargin=1.35 * cm, bottomMargin=1.5 * cm)
    frame = Frame(document.leftMargin, document.bottomMargin, document.width, document.height, id="guide")
    document.addPageTemplates([PageTemplate(id="guide", frames=[frame], onPage=draw_footer)])

    story = [
        Spacer(1, 0.35 * cm),
        Paragraph("Terminal-Agent 快速安装手册", styles["title"]),
        Paragraph(f"Windows 独立 ZIP 安装方式  -  v{version}", styles["subtitle"]),
        Paragraph("本 ZIP 解压后就是一个独立安装文件夹。快速安装脚本会自动完成 AccessClient 中继替换，并把 Terminal-Agent 安装包放在最后一步启动；用户只需要完成安装向导和堡垒机界面的一个配置选择。", styles["lead"]),
        callout("<b>重要：</b>请先把 ZIP 完整解压到本地文件夹，再双击 <b>快速安装脚本.cmd</b>。不要在压缩包内运行，也不要把整个 ZIP 文件夹复制到 AccessClient 安装目录。", styles),
        Spacer(1, 0.35 * cm),
        Paragraph("一键安装流程", styles["heading"]),
        card("1", "解压 ZIP", "将 Terminal-Agent-Quick-Install-3.2.0.zip 解压到独立文件夹，并确认文件夹内能看到 putty.exe、Terminal-Agent-Setup-3.2.0.exe 和快速安装脚本.cmd。", styles),
        Spacer(1, 0.16 * cm),
        card("2", "运行快速安装脚本", "双击快速安装脚本.cmd。脚本会读取 HKCR\\accessclient\\shell\\open\\command，定位当前 AccessClient 安装目录；如果没有注册信息，可用 /AccessClientDir 参数指定目录。", styles),
        Spacer(1, 0.16 * cm),
        card("3", "自动备份并复制中继", "脚本先把原 putty.exe 保留为 putty.exe.bak，再复制 ZIP 内的 putty.exe 并做文件校验。目录受保护时会弹出 Windows 管理员权限确认。已有备份不会被覆盖。", styles),
        Spacer(1, 0.16 * cm),
        card("4", "最后启动安装包", "中继替换成功后，脚本最后才启动 Terminal-Agent-Setup-3.2.0.exe。请在安装向导中自行选择目录并完成安装；安装完成后可按提示启动应用。", styles),
        PageBreak(),
        Paragraph("安装完成后的堡垒机设置", styles["heading"]),
        callout("<b>【配置须知】</b>AccessClient 的“会话配置”中，“会话访问方式”必须选择“使用全局设置(putty)”。该设置属于厂商界面状态，脚本不会修改未知的 AccessClient 配置文件。", styles, background="#fff7e5", border="#c39235"),
        Spacer(1, 0.28 * cm),
        Paragraph("选择全局 putty 后，使用集团堡垒机正常指定主机 SSH 连接即可。AccessClient 会通过已复制的中继程序唤起 Terminal-Agent。", styles["body"]),
        Paragraph("常用参数", styles["heading"]),
        Paragraph("离线安装只使用 ZIP 内文件：", styles["body"]),
        Paragraph("快速安装脚本.cmd /NoDownload", styles["code"]),
        Paragraph("指定 AccessClient 目录（路径可包含空格）：", styles["body"]),
        Paragraph('快速安装脚本.cmd /AccessClientDir "D:\\AccessClient"', styles["code"]),
        Paragraph("安装完成后不自动启动应用：", styles["body"]),
        Paragraph("快速安装脚本.cmd /NoLaunch", styles["code"]),
        Paragraph("故障排查与恢复", styles["heading"]),
        Paragraph("如果脚本在安装包启动前失败，会尝试恢复本次运行创建的备份；原始备份文件仍会保留。如需手动恢复，请先退出 AccessClient，删除中继 putty.exe，再将 putty.exe.bak 改回 putty.exe。如果注册表查询失败，请关闭 AccessClient 后重试，或使用 /AccessClientDir 指定目录。", styles["body"]),
        callout("<b>【使用须知】</b>使用集团堡垒机正常指定主机 SSH 连接即可。请勿将来源不明的 putty.exe 或安装包替换到 ZIP 中。", styles),
        Spacer(1, 0.28 * cm),
        Paragraph("ZIP 文件清单", styles["heading"]),
    ]

    assets = [
        [Paragraph("文件", styles["stepHeading"]), Paragraph("用途", styles["stepHeading"])],
        [Paragraph("putty.exe", styles["body"]), Paragraph("AccessClient 中继程序", styles["body"])],
        [Paragraph(f"Terminal-Agent-Setup-{version}.exe", styles["body"]), Paragraph("Windows 安装包", styles["body"])],
        [Paragraph("快速安装脚本.cmd", styles["body"]), Paragraph("自动定位、备份、复制并启动安装包", styles["body"])],
        [Paragraph("快速安装手册.md / .pdf", styles["body"]), Paragraph("文本版和打印版说明", styles["body"])],
    ]
    asset_table = Table(assets, colWidths=[7.4 * cm, 9.6 * cm], repeatRows=1)
    asset_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eee6f6")),
        ("GRID", (0, 0), (-1, -1), 0.45, colors.HexColor("#ded2ec")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 8), ("RIGHTPADDING", (0, 0), (-1, -1), 8),
        ("TOPPADDING", (0, 0), (-1, -1), 7), ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    story.append(asset_table)

    screenshot = image_or_none(IMAGE_DIRECTORY / "06-select-global-putty.png", 8.0 * cm, 5.0 * cm)
    launch_shot = image_or_none(IMAGE_DIRECTORY / "07-launch-bastion.png", 8.0 * cm, 5.0 * cm)
    if screenshot or launch_shot:
        # Keep the section heading with its screenshots; otherwise a tight
        # second-page layout can strand the heading at the page bottom.
        story.extend([PageBreak(), Paragraph("配置界面示意", styles["heading"])])
        cells = []
        if screenshot:
            cells.append([screenshot, Paragraph("会话访问方式选择全局 putty", styles["small"])])
        if launch_shot:
            cells.append([launch_shot, Paragraph("按集团堡垒机原流程指定主机", styles["small"])])
        if cells:
            shot_table = Table([cells], colWidths=[8.25 * cm, 8.25 * cm], hAlign="LEFT")
            shot_table.setStyle(TableStyle([
                ("VALIGN", (0, 0), (-1, -1), "TOP"), ("ALIGN", (0, 0), (-1, -1), "CENTER"),
                ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
            ]))
            story.append(shot_table)

    document.build(story)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate the Terminal-Agent standalone quick-install PDF")
    parser.add_argument("--output", type=Path, default=ROOT / "release" / "快速安装手册.pdf")
    args = parser.parse_args()
    build_pdf(args.output.resolve())
    # Windows may still expose a legacy cp1252 console even though the output
    # filename is intentionally Chinese.  Write UTF-8 directly so generation
    # succeeds instead of failing only while reporting the completed artifact.
    sys.stdout.buffer.write((str(args.output.resolve()) + "\n").encode("utf-8"))


if __name__ == "__main__":
    main()
