from __future__ import annotations

import os
from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    HRFlowable,
    Image,
    KeepTogether,
    NextPageTemplate,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "output" / "pdf"
OUT_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT = OUT_DIR / "relayskills-website-product-and-design-specification.pdf"


# relayskills rebrand direction: a calmer, warmer evolution of the existing
# blue-purple-pink relayskills system.
INK = colors.HexColor("#0B1F2A")
INK_2 = colors.HexColor("#153747")
TEAL = colors.HexColor("#1C9C86")
MINT = colors.HexColor("#6EE7C8")
SKY = colors.HexColor("#77A8FF")
CORAL = colors.HexColor("#FF8A72")
VIOLET = colors.HexColor("#8C7CFF")
CREAM = colors.HexColor("#FFF7EA")
PAPER = colors.HexColor("#F5F7F8")
LINE = colors.HexColor("#D9E3E6")
MUTED = colors.HexColor("#5D7078")
WHITE = colors.white
PALE_TEAL = colors.HexColor("#E5F7F2")
PALE_BLUE = colors.HexColor("#EAF1FF")
PALE_CORAL = colors.HexColor("#FFF0EC")
PALE_VIOLET = colors.HexColor("#F0EEFF")


styles = getSampleStyleSheet()
styles.add(ParagraphStyle(
    name="DocTitle",
    parent=styles["Title"],
    fontName="Helvetica-Bold",
    fontSize=29,
    leading=32,
    textColor=WHITE,
    spaceAfter=12,
))
styles.add(ParagraphStyle(
    name="CoverSub",
    parent=styles["Normal"],
    fontName="Helvetica",
    fontSize=11.5,
    leading=17,
    textColor=colors.HexColor("#D6F2EC"),
    spaceAfter=8,
))
styles.add(ParagraphStyle(
    name="CoverMeta",
    parent=styles["Normal"],
    fontName="Helvetica-Bold",
    fontSize=8.2,
    leading=11,
    textColor=colors.HexColor("#A5C7C8"),
    tracking=1,
))
styles.add(ParagraphStyle(
    name="Section",
    parent=styles["Heading1"],
    fontName="Helvetica-Bold",
    fontSize=19,
    leading=23,
    textColor=INK,
    spaceBefore=8,
    spaceAfter=8,
    keepWithNext=True,
))
styles.add(ParagraphStyle(
    name="Subsection",
    parent=styles["Heading2"],
    fontName="Helvetica-Bold",
    fontSize=12.5,
    leading=16,
    textColor=INK_2,
    spaceBefore=10,
    spaceAfter=5,
    keepWithNext=True,
))
styles.add(ParagraphStyle(
    name="Body",
    parent=styles["BodyText"],
    fontName="Helvetica",
    fontSize=9.1,
    leading=13.5,
    textColor=INK,
    spaceAfter=6,
))
styles.add(ParagraphStyle(
    name="Small",
    parent=styles["BodyText"],
    fontName="Helvetica",
    fontSize=7.7,
    leading=10.5,
    textColor=MUTED,
    spaceAfter=3,
))
styles.add(ParagraphStyle(
    name="Tiny",
    parent=styles["BodyText"],
    fontName="Helvetica",
    fontSize=6.7,
    leading=8.6,
    textColor=MUTED,
))
styles.add(ParagraphStyle(
    name="Lead",
    parent=styles["BodyText"],
    fontName="Helvetica",
    fontSize=11,
    leading=16,
    textColor=INK_2,
    spaceAfter=9,
))
styles.add(ParagraphStyle(
    name="Kicker",
    parent=styles["Normal"],
    fontName="Helvetica-Bold",
    fontSize=7.5,
    leading=10,
    textColor=TEAL,
    spaceAfter=4,
    tracking=1,
))
styles.add(ParagraphStyle(
    name="CardTitle",
    parent=styles["Heading3"],
    fontName="Helvetica-Bold",
    fontSize=10.2,
    leading=13,
    textColor=INK,
    spaceAfter=3,
))
styles.add(ParagraphStyle(
    name="TableHead",
    parent=styles["Normal"],
    fontName="Helvetica-Bold",
    fontSize=7.4,
    leading=9.3,
    textColor=WHITE,
))
styles.add(ParagraphStyle(
    name="TableCell",
    parent=styles["Normal"],
    fontName="Helvetica",
    fontSize=7.35,
    leading=9.8,
    textColor=INK,
))
styles.add(ParagraphStyle(
    name="TableCellBold",
    parent=styles["Normal"],
    fontName="Helvetica-Bold",
    fontSize=7.35,
    leading=9.8,
    textColor=INK,
))
styles.add(ParagraphStyle(
    name="CalloutTitle",
    parent=styles["Heading3"],
    fontName="Helvetica-Bold",
    fontSize=10,
    leading=13,
    textColor=INK,
    spaceAfter=3,
))
styles.add(ParagraphStyle(
    name="CalloutBody",
    parent=styles["BodyText"],
    fontName="Helvetica",
    fontSize=8.2,
    leading=11.6,
    textColor=INK_2,
))
styles.add(ParagraphStyle(
    name="Footer",
    parent=styles["Normal"],
    fontName="Helvetica",
    fontSize=7,
    leading=8,
    textColor=colors.HexColor("#7A8C92"),
))


def p(text: str, style: str = "Body") -> Paragraph:
    return Paragraph(text, styles[style])


def plain(text: str, style: str = "Body") -> Paragraph:
    return p(escape(text), style)


def bullets(items: list[str], style: str = "Body", gap: float = 1.8) -> list[Paragraph | Spacer]:
    out: list[Paragraph | Spacer] = []
    for item in items:
        out.append(p("- " + item, style))
        out.append(Spacer(1, gap))
    return out


def section(title: str, kicker: str | None = None) -> list:
    out = []
    if kicker:
        out.append(p(kicker.upper(), "Kicker"))
    out.append(p(title, "Section"))
    out.append(HRFlowable(width="100%", thickness=1, color=LINE, spaceBefore=1, spaceAfter=10))
    return out


def callout(title: str, body: str, fill=PALE_TEAL, accent=TEAL) -> Table:
    content = [p(title, "CalloutTitle"), p(body, "CalloutBody")]
    t = Table([[content]], colWidths=[175 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), fill),
        ("BOX", (0, 0), (-1, -1), 0.8, accent),
        ("LINEBEFORE", (0, 0), (0, -1), 4, accent),
        ("LEFTPADDING", (0, 0), (-1, -1), 12),
        ("RIGHTPADDING", (0, 0), (-1, -1), 12),
        ("TOPPADDING", (0, 0), (-1, -1), 9),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
    ]))
    return t


def card(title: str, body: str, fill=WHITE, accent=TEAL) -> Table:
    content = [p(title, "CardTitle"), p(body, "Small")]
    t = Table([[content]], colWidths=[84 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), fill),
        ("BOX", (0, 0), (-1, -1), 0.7, LINE),
        ("LINEABOVE", (0, 0), (-1, 0), 3, accent),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 10),
        ("RIGHTPADDING", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 9),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 9),
    ]))
    return t


def two_cards(left: Table, right: Table) -> Table:
    t = Table([[left, right]], colWidths=[87 * mm, 87 * mm], hAlign="LEFT")
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    return t


def table(headers: list[str], rows: list[list[str]], widths: list[float] | None = None, first_col_bold=False) -> Table:
    data = [[p(h, "TableHead") for h in headers]]
    for row in rows:
        cells = []
        for i, value in enumerate(row):
            cells.append(p(value, "TableCellBold" if first_col_bold and i == 0 else "TableCell"))
        data.append(cells)
    if widths is None:
        widths = [175 * mm / len(headers)] * len(headers)
    t = Table(data, colWidths=widths, repeatRows=1, hAlign="LEFT")
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), INK_2),
        ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
        ("GRID", (0, 0), (-1, -1), 0.45, LINE),
        ("BACKGROUND", (0, 1), (-1, -1), WHITE),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, PAPER]),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, 0), 7),
        ("BOTTOMPADDING", (0, 0), (-1, 0), 7),
        ("TOPPADDING", (0, 1), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 1), (-1, -1), 6),
    ]))
    return t


def flow_box(label: str, text: str, fill, accent, width: float = 37 * mm, height: float = 22 * mm) -> Table:
    content = [p(label, "CardTitle"), p(text, "Tiny")]
    t = Table([[content]], colWidths=[width], rowHeights=[height])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), fill),
        ("BOX", (0, 0), (-1, -1), 0.7, accent),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return t


def flow_row(boxes: list[Table], arrows: list[str] | None = None) -> Table:
    cells = []
    for i, box in enumerate(boxes):
        if i:
            cells.append(p(arrows[i - 1] if arrows and i - 1 < len(arrows) else "->", "CardTitle"))
        cells.append(box)
    compact = len(boxes) >= 5
    arrow_width = 5 * mm if compact else 8 * mm
    widths = []
    for cell in cells:
        widths.append(arrow_width if isinstance(cell, Paragraph) else cell._colWidths[0])
    t = Table([cells], colWidths=widths, hAlign="LEFT")
    t.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    return t


def palette_table() -> Table:
    names = [
        ("Deep Fjord", "#0B1F2A", INK, "Primary canvas, nav, admin shell"),
        ("relayskills Teal", "#1C9C86", TEAL, "Primary action, links, success"),
        ("Sea Glass", "#6EE7C8", MINT, "Highlights, active accents"),
        ("Open Sky", "#77A8FF", SKY, "Discovery and learning"),
        ("Warm Coral", "#FF8A72", CORAL, "Human warmth, alerts, stories"),
        ("Soft Violet", "#8C7CFF", VIOLET, "Creative work, premium moments"),
        ("Cream Paper", "#FFF7EA", CREAM, "Editorial surfaces and hero panels"),
    ]
    data = [[p("Color", "TableHead"), p("Hex", "TableHead"), p("Use", "TableHead")]]
    for name, hx, color, use in names:
        swatch = Table([[""]], colWidths=[12 * mm], rowHeights=[8 * mm])
        swatch.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), color), ("BOX", (0, 0), (-1, -1), 0.5, LINE)]))
        data.append([Table([[swatch, p(name, "TableCellBold")]], colWidths=[17 * mm, 30 * mm]), p(hx, "TableCell"), p(use, "TableCell")])
    t = Table(data, colWidths=[70 * mm, 30 * mm, 75 * mm], repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), INK_2),
        ("GRID", (0, 0), (-1, -1), 0.45, LINE),
        ("BACKGROUND", (0, 1), (-1, -1), WHITE),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, PAPER]),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    return t


def cover_canvas(canvas, doc):
    w, h = A4
    canvas.saveState()
    canvas.setFillColor(INK)
    canvas.rect(0, 0, w, h, fill=1, stroke=0)
    # Layered arcs echo the idea of exchange without copying the current logo.
    for radius, color, alpha in [(115 * mm, TEAL, 0.18), (86 * mm, VIOLET, 0.16), (55 * mm, CORAL, 0.20)]:
        canvas.setStrokeColor(color)
        canvas.setLineWidth(3.2 * mm)
        canvas.setStrokeAlpha(alpha)
        canvas.arc(w - radius, h - radius - 24 * mm, w + radius, h + radius - 24 * mm, 205, 108)
    canvas.setStrokeAlpha(1)
    canvas.setFillColor(MINT)
    canvas.roundRect(22 * mm, h - 52 * mm, 32 * mm, 6 * mm, 3 * mm, fill=1, stroke=0)
    canvas.setFillColor(CORAL)
    canvas.circle(60 * mm, h - 49 * mm, 3 * mm, fill=1, stroke=0)
    canvas.setFillColor(WHITE)
    canvas.setFont("Helvetica-Bold", 7)
    canvas.drawString(22 * mm, 22 * mm, "relayskills PRODUCT + DESIGN SPECIFICATION")
    canvas.setFillColor(colors.HexColor("#A5C7C8"))
    canvas.setFont("Helvetica", 7)
    canvas.drawRightString(w - 22 * mm, 22 * mm, "relayskills.com")
    canvas.restoreState()


def body_canvas(canvas, doc):
    w, h = A4
    canvas.saveState()
    canvas.setFillColor(PAPER)
    canvas.rect(0, 0, w, h, fill=1, stroke=0)
    canvas.setFillColor(INK)
    canvas.rect(0, h - 12 * mm, w, 12 * mm, fill=1, stroke=0)
    canvas.setFillColor(MINT)
    canvas.rect(18 * mm, h - 7.6 * mm, 13 * mm, 1.4 * mm, fill=1, stroke=0)
    canvas.setFillColor(WHITE)
    canvas.setFont("Helvetica-Bold", 7.4)
    canvas.drawString(36 * mm, h - 8.2 * mm, "relayskills / WEBSITE SPECIFICATION")
    canvas.setFillColor(colors.HexColor("#C9E7E3"))
    canvas.setFont("Helvetica", 7.2)
    canvas.drawRightString(w - 18 * mm, h - 8.2 * mm, "relayskills.com")
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.5)
    canvas.line(18 * mm, 15 * mm, w - 18 * mm, 15 * mm)
    canvas.setFillColor(MUTED)
    canvas.setFont("Helvetica", 7)
    canvas.drawString(18 * mm, 9 * mm, "Prepared as a rebrand and design-direction brief")
    canvas.drawRightString(w - 18 * mm, 9 * mm, f"{doc.page}")
    canvas.restoreState()


class SpecDocTemplate(BaseDocTemplate):
    def __init__(self, filename, **kwargs):
        super().__init__(filename, pagesize=A4, **kwargs)
        cover_frame = Frame(22 * mm, 28 * mm, 166 * mm, 235 * mm, id="cover", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
        body_frame = Frame(18 * mm, 22 * mm, 174 * mm, 258 * mm, id="body", leftPadding=0, rightPadding=0, topPadding=6 * mm, bottomPadding=4 * mm)
        self.addPageTemplates([
            PageTemplate(id="Cover", frames=[cover_frame], onPage=cover_canvas),
            PageTemplate(id="Body", frames=[body_frame], onPage=body_canvas),
        ])


story = []

# Cover
story.append(Spacer(1, 38 * mm))
story.append(p("PRODUCT + DESIGN SPECIFICATION", "CoverMeta"))
story.append(Spacer(1, 5 * mm))
story.append(p("relayskills", "DocTitle"))
story.append(p("A detailed blueprint for a skill-sharing, learning, community, and opportunity platform at <b>relayskills.com</b>.", "CoverSub"))
story.append(Spacer(1, 8 * mm))
story.append(p("This document translates the existing relayskills website into a rebranded relayskills product story. It records the full page ecosystem, explains the feature behavior and interaction model, and proposes a warmer, more distinctive visual theme while preserving the platform's central promise: people can teach what they know, learn what they need, and turn useful exchanges into visible progress.", "CoverSub"))
story.append(Spacer(1, 12 * mm))
story.append(Table([[p("DOCUMENT SCOPE", "CoverMeta"), p("CURRENT PRODUCT BASIS", "CoverMeta")], [p("Whole website inventory, design system, role-based workflows, responsive behavior, content architecture, security model, and relayskills theme direction.", "CoverSub"), p("Public pages, authenticated member tools, mentor and organization areas, community features, credits, live sessions, and administrator operations.", "CoverSub")]], colWidths=[79 * mm, 79 * mm], style=TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 8), ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 0)])))
story.append(Spacer(1, 18 * mm))
story.append(p("Prepared 22 September 2026", "CoverMeta"))
story.append(NextPageTemplate("Body"))
story.append(PageBreak())

# 1. Executive summary
story += section("1. Executive summary", "Orientation")
story.append(p("relayskills is best understood as a community learning operating system, not a single marketplace. Its interface connects four related experiences: discovery of people and skills, exchange of time and practical help, public/community participation, and personal progress tracking. The existing product already has the structure for all four; the rebrand should make the relationship between them easier to understand at first glance.", "Lead"))
story.append(two_cards(
    card("The promise", "Help people move from curiosity to a useful human connection, then from a connection to a completed exchange that can be remembered, repeated, and trusted.", PALE_TEAL, TEAL),
    card("The product shape", "A public discovery layer feeds into member workspaces, conversation and scheduling tools, live rooms, credit history, portfolios, and community contribution loops.", PALE_BLUE, SKY),
))
story.append(Spacer(1, 9))
story.append(callout("Rebrand principle", "Keep the platform's practical exchange model, but make the emotional center warmer and more human. relayskills should feel like an open learning neighborhood with clear tools, not like a generic productivity dashboard.", PALE_CORAL, CORAL))
story.append(Spacer(1, 10))
story.append(p("What the website needs to communicate in its first minute:", "Subsection"))
story.extend(bullets([
    "Every member can arrive with something to teach and something to learn.",
    "Profiles are structured enough to produce useful matches, but expressive enough to show personality and intent.",
    "A swap is a real workflow: match, message, schedule, meet, record, and follow up.",
    "Time credits and activity records make contribution visible without making learning feel competitive by default.",
    "Safety, privacy, child protections, and administrator controls are part of the experience rather than hidden afterthoughts.",
], "Body"))

# 2. Product architecture
story += section("2. Product architecture and information model", "How the parts fit")
story.append(p("The site is organized as a public-to-private progression. Visitors can understand the mission and browse real opportunities before creating an account. Members then move into a personalized workspace, while mentors, organizations, and administrators receive role-specific tools. The navigation should expose the breadth of the product without forcing every page into the primary header.", "Body"))
story.append(flow_row([
    flow_box("Discover", "Home, skills, mentors, media, stories", PALE_BLUE, SKY),
    flow_box("Join", "Register, safety, profile, preferences", PALE_TEAL, TEAL),
    flow_box("Exchange", "Match, message, calendar, live room", PALE_CORAL, CORAL),
    flow_box("Grow", "Journal, portfolio, achievements, credits", PALE_VIOLET, VIOLET),
], ["->", "->", "->"]))
story.append(Spacer(1, 12))
story.append(table(
    ["Layer", "Primary audience", "Core job", "Key surfaces"],
    [
        ["Public discovery", "Visitors and prospective members", "Understand the idea and find a reason to join", "Home, How it works, Browse Skills, Mentors, Media, Stories, FAQ"],
        ["Member workspace", "Signed-in learners and teachers", "Turn intent into matches, sessions, records, and progress", "Dashboard, Profile, Portfolio, Journal, Calendar, Chats, Credits"],
        ["Opportunity layer", "Members, mentors, partners, creators", "Find practical work, workshops, projects, and support", "relayskills Tasks, Marketplace, Workshops, Innovation, Funding, Events"],
        ["Community layer", "The wider learning community", "Share, discuss, challenge, and encourage", "Community, Forums, Groups, Livestreams, Leaderboards, Achievements"],
        ["Operations layer", "Organization owners and administrators", "Protect trust and keep the service functioning", "Organization admin, Admin gate, Admin dashboard, Moderation, Audit"],
    ], [29 * mm, 34 * mm, 54 * mm, 58 * mm], True))
story.append(Spacer(1, 10))
story.append(callout("Terminology direction for relayskills", "Use 'exchange' for the overall act of learning and teaching, 'session' for a scheduled meeting, 'credit' for the time-based record, 'circle' for a group, and 'contribution' for public participation. Keep 'match' for the recommendation step and 'portfolio' for proof of work.", PALE_VIOLET, VIOLET))

# 3. Global design
story += section("3. Global design language", "The visual system")
story.append(p("The current website uses a polished, modern education-platform language: a floating rounded header, large editorial hero type, soft gradients, pill-shaped controls, elevated cards, and a blue-indigo-pink accent family. relayskills should keep the clarity and generous spacing, but replace the familiar purple gradient signature with a more ownable palette that suggests sea glass, warmth, and human connection.", "Body"))
story.append(two_cards(
    card("Layout grammar", "Use a centered content rail around 1,200 to 1,260px on desktop; switch to full-width stacked sections below tablet; let hero cards overlap stat strips slightly; keep cards visually quiet so real member data stays primary.", WHITE, TEAL),
    card("Interaction grammar", "Use obvious primary actions, short labels, inline status messages, reversible settings, visible loading states, and a clear distinction between public content, personal records, and administrative controls.", WHITE, CORAL),
))
story.append(Spacer(1, 10))
story.append(p("Signature components to preserve and refine:", "Subsection"))
story.extend(bullets([
    "Floating glass header: a centered capsule with a small brand mark, primary routes, directory/explore control, and account actions.",
    "Hero split: editorial copy on one side and a believable product panel, profile card, match preview, or session summary on the other.",
    "Metric strip: four compact, evidence-based counters that connect the story to real platform records.",
    "Feature card: icon, short label, one clear explanation, and an action. Avoid card walls where every item has equal emphasis.",
    "Status language: show empty, loading, success, error, and private states with the same visual vocabulary across the site.",
    "Responsive menu: collapse discovery links into a compact menu without removing the most important action, such as finding a skill or signing in.",
], "Body"))

# 4. Theme
story += section("4. relayskills theme change", "New visual direction")
story.append(p("Theme name: <b>Sea Glass + Sunlit Coral</b>. The concept keeps the existing platform's optimism but gives it a distinct atmosphere: deep fjord blue for trust, teal for exchange, sea-glass mint for progress, open sky blue for discovery, warm coral for human energy, and soft violet for creative work. Cream paper surfaces add an editorial, tactile counterpoint to the current cool white canvas.", "Lead"))
story.append(palette_table())
story.append(Spacer(1, 10))
story.append(table(
    ["Dimension", "Current tendency", "relayskills change", "Reason"],
    [
        ["Color", "Blue, indigo, pink gradients on pale white or navy", "Deep fjord + teal as the anchor; coral as the human accent; mint and sky for states", "Makes the brand less interchangeable with generic SaaS gradients"],
        ["Typography", "Rounded, heavy display headings with Inter/system body", "Use a friendly geometric display face such as Sora or Manrope with Inter/system fallback", "Creates an approachable voice while preserving legibility"],
        ["Surfaces", "White cards, soft gray backgrounds, occasional dark panels", "Cream editorial surfaces, fjord dark mode, quieter borders, selective color blocks", "Gives pages a stronger sense of place"],
        ["Corners", "Large rounded pills and 20-28px cards", "Keep the capsule header; use 16-20px cards and 12-14px field controls", "Preserves warmth without making every object look like a button"],
        ["Motion", "Small lift and shadow transitions", "160-240ms ease-out, gentle arc/line reveals, reduced-motion fallback", "Adds character without distracting from learning tasks"],
        ["Imagery", "Logo and profile/avatar accents; mostly interface-led", "Use documentary-style hands, notes, work-in-progress details, and simple line illustrations", "Shows learning as something people do together"],
    ], [27 * mm, 47 * mm, 60 * mm, 41 * mm], True))
story.append(Spacer(1, 10))
story.append(callout("Theme guardrail", "The new color system must never reduce contrast or turn status colors into decoration. Teal and coral are accents; text remains fjord-dark on light surfaces and pale blue-white on dark surfaces. Focus rings, keyboard states, reduced motion, and readable form errors remain non-negotiable.", PALE_CORAL, CORAL))

# 5. Header/footer/navigation
story += section("5. Header, navigation, and footer", "Global shell")
story.append(p("Every page is wrapped in a shared shell. At desktop widths the header floats near the top with a blurred, translucent backing and a fully rounded capsule silhouette. The left side carries the brand; the middle carries a small set of high-value discovery routes; the right side carries Explore, authentication, and account actions. At narrow widths, the brand mark and a compact menu remain visible while secondary nav links collapse.", "Body"))
story.append(table(
    ["Area", "Behavior", "relayskills treatment"],
    [
        ["Brand", "Mark plus wordmark; links home", "Use the relayskills wordmark with a new loop or linked-path mark. Keep the mark legible at 40-44px."],
        ["Primary navigation", "Swap/skills/how it works/community-style routes", "Use 'Exchange', 'Skills', 'How it works', and 'Circles' as the four recognizable anchors."],
        ["Explore", "Directory menu for the large feature set", "Group destinations into Learn, Exchange, Community, Opportunities, and About rather than a flat list."],
        ["Auth actions", "Log in and create account before sign-in; icons and avatar after sign-in", "Make 'Find a skill' the visual primary action; keep account controls calm and predictable."],
        ["Footer", "Brand story, newsletter, link groups, legal, social", "Use the footer as a final orientation map and trust statement, not a second mega-menu."],
    ], [30 * mm, 58 * mm, 87 * mm], True))
story.append(Spacer(1, 9))
story.append(p("Recommended Explore structure", "Subsection"))
story.extend(bullets([
    "Learn: Browse Skills, Skill Matching, Skill Assessments, Learning Paths, Learning Journal, Workshops, Live Sessions, Courses.",
    "Exchange: relayskills Tasks, Marketplace, Mentors, Become a Mentor, Calendar, Session Rooms, Portfolio.",
    "Community: Community, Forums, Groups, Challenges, Livestreams, Achievements, Leaderboards, Stories.",
    "Opportunities: Projects, Innovation Lab, Funding Hub, Events, Gifts, Rewards, Credits.",
    "About: Our Story, Team, Careers, Partner With Us, Blog, Resources, FAQ, Help Center, Contact.",
], "Body"))

# 6. Home and public discovery
story += section("6. Public discovery and marketing pages", "Visitor experience")
story.append(p("The public layer should feel complete even before sign-in. It explains the model, provides routes into real content, and makes the value of a structured profile obvious. The public pages should never imply that a record exists when it does not; empty states and availability statements are part of the product's honesty.", "Body"))
story.append(table(
    ["Page family", "Purpose and feature behavior", "Design emphasis"],
    [
        ["Home", "The entry point: headline, value proposition, available-now or first-to-list-skill framing, match preview, proof metrics, and routes into discovery.", "High-contrast hero, product panel, proof strip, clear first action."],
        ["How it works", "Explains the progression from profile to match to useful session, plus expectations for a fair exchange.", "Numbered steps, human language, fewer abstract claims."],
        ["Browse Skills", "Lets visitors browse skill categories and move toward a member or match flow.", "Search/filter affordance, category chips, real inventory states."],
        ["Skill Matching", "Frames the matching logic and lets signed-in members submit a learning/teaching request.", "Reason cards, match confidence language, clear next step."],
        ["Mentors and Media", "Surfaces people, stories, testimonials, and learning inspiration without requiring a transaction.", "Human profile cards, circular avatars, identity accents, editorial pacing."],
        ["Blog, Resources, FAQ, Help", "Answers questions, shares context, and handles support without hiding the route to a human.", "Readable article measure, search-friendly headings, calm empty states."],
        ["About, Team, Careers, Partner", "Explains the project, credits the people building it, and provides collaboration routes.", "Mission-led editorial blocks and transparent product status."],
        ["Terms, Privacy, Credits", "Sets expectations for behavior, data, safety, and the origins of the product.", "Plain language, stable layout, strong link hierarchy."],
    ], [34 * mm, 93 * mm, 48 * mm], True))
story.append(Spacer(1, 10))
story.append(callout("Content rule for relayskills", "Replace broad promises such as 'learn anything' with observable outcomes: find a person, schedule a session, complete a task, record a reflection, or publish work. Trust grows when every claim points to a visible action.", PALE_TEAL, TEAL))

# 7. Account onboarding
story += section("7. Account creation, sign-in, and profile onboarding", "Identity and first value")
story.append(p("Registration is not a single short form; it is the start of the matching model. The existing account flow collects identity, contact details, location, language, skills to teach, skills to learn, preferences, profile color, and safety information. relayskills should make that structure feel manageable by staging it into progressive steps while keeping the final profile comprehensive.", "Body"))
story.append(flow_row([
    flow_box("1. Join", "Name, username, email, password, terms", PALE_BLUE, SKY),
    flow_box("2. Stay safe", "Age, account type, guardian consent when needed", PALE_CORAL, CORAL),
    flow_box("3. Describe", "Location, languages, skills, goal, availability", PALE_TEAL, TEAL),
    flow_box("4. Match", "Suggested people and first action", PALE_VIOLET, VIOLET),
], ["->", "->", "->"]))
story.append(Spacer(1, 11))
story.append(table(
    ["Flow", "Detailed behavior", "Required design response"],
    [
        ["Register", "Accept username, email, password, name, date of birth, country, primary language, teaching skill, learning skill, account type, and terms acceptance. Validate visibly and keep field labels persistent.", "Show step progress, inline errors, password policy near the field, and a final review state."],
        ["Login", "Accept username, email, or phone plus password. Preserve a clear path to account creation and organization registration.", "Use one obvious identity field, one password field, visible show/hide control, and an accessible error summary."],
        ["Student safety", "Under-13 accounts use child mode, hide location by default, require guardian details and consent, and use specialist review for innovation access.", "Explain why information is requested; never use alarming language or expose a child's location publicly."],
        ["Profile", "Members manage identity, pronouns, location, languages, role, organization, bio, availability, learning goal, teaching/learning skills, profile color, photo, and privacy preferences.", "Make completeness useful rather than punitive; show what each missing field unlocks."],
        ["Password recovery", "Passwords remain one-way hashed. Admin and organization owners can generate a one-time temporary password for a member, invalidate current sessions, and require the member to change it.", "Explain the reset flow clearly; never design a password viewer or plaintext credential table."],
    ], [27 * mm, 98 * mm, 50 * mm], True))

# 8. Member workspace
story += section("8. Authenticated member workspace", "The everyday product")
story.append(p("The member workspace is the center of gravity after onboarding. It should make the next useful action obvious while preserving a sense of personal history. The dashboard combines summary statistics, onboarding guidance, matches, next actions, learning goals, activity charts, and platform metrics. Related tools then let a member complete the exchange and show what happened afterward.", "Body"))
story.append(table(
    ["Surface", "What it does", "Primary interaction"],
    [
        ["Dashboard", "Shows credit balance, pending requests, unread messages, completed sessions, profile readiness, session rhythm, community contribution, matches, next actions, and learning goal.", "Choose the next action: discover, connect, schedule, reflect, or contribute."],
        ["Profile", "Stores the identity and matching fields that power discovery and recommendation.", "Edit structured details, upload a photo, choose an accent, set visibility and preferences."],
        ["Portfolio", "Lets members add projects, include completed relayskills Tasks, choose public/private visibility, and preview the public presentation.", "Create or edit a project, set visibility, and share a controlled public view."],
        ["Chats / notifications", "Supports conversations, inbox states, follow requests, meeting messages, reports, and notification read states.", "Open a conversation, respond, schedule, attach context, or mark as handled."],
        ["Calendar", "Combines availability and scheduled events so a promising exchange becomes a real time slot.", "Set availability, create events, and open the correct session room."],
        ["Credits", "Maintains a time-credit ledger with reasons, references, transfers, balances, and disputes.", "Review history, transfer credits where allowed, or raise a dispute."],
        ["Learning Journal", "Stores reflection and practice minutes on the member account.", "Add a short entry after a session and connect it to a goal."],
        ["Achievements", "Makes recorded progress visible without inventing milestones.", "Pin meaningful achievements or display recorded progress."],
    ], [31 * mm, 90 * mm, 54 * mm], True))
story.append(Spacer(1, 10))
story.append(callout("Dashboard design recommendation", "Use a single 'Today' or 'Next useful action' panel above the analytics grid. Keep metrics as context, not the first task. A learner should know what to do next within five seconds of opening the dashboard.", PALE_BLUE, SKY))

# 9. Exchange/workflows
story += section("9. Exchange workflows: match, message, schedule, meet, record", "Core loop")
story.append(p("The core exchange should read as one continuous journey even though it crosses several pages. The current implementation contains separate components for matching, swaps, conversations, calendar events, session rooms, video rooms, and journaling. relayskills should connect those components with visible state and consistent language.", "Body"))
story.append(flow_row([
    flow_box("Match", "Compare what I teach with what I want to learn", PALE_BLUE, SKY),
    flow_box("Connect", "Request a swap and start a conversation", PALE_TEAL, TEAL),
    flow_box("Schedule", "Agree on time, format, and expectations", PALE_CORAL, CORAL),
    flow_box("Complete", "Meet, record, and carry the learning forward", PALE_VIOLET, VIOLET),
], ["->", "->", "->"]))
story.append(Spacer(1, 11))
story.append(table(
    ["Moment", "Required state", "Failure / empty state"],
    [
        ["Match", "The member sees why a person was suggested: skill overlap, learning goal, format, availability, or location preference.", "Explain that no suitable match exists yet and offer profile improvements or a broader search."],
        ["Request", "The receiver can understand the proposed exchange and accept, decline, or ask for clarification.", "Keep the request visible in the inbox with a pending label and no ambiguous silent failure."],
        ["Schedule", "Both sides can see time, timezone, format, and event context before confirming.", "Show conflict information and offer alternate availability rather than a generic error."],
        ["Room", "The session room identifies participants, status, host controls, camera/microphone checks, and a route back to the conversation.", "If the room is unavailable, show the reason and provide a safe retry or reschedule action."],
        ["After", "The session can lead to credits, a journal entry, a portfolio item, feedback, and a future recommendation.", "Never invent completion. Show what remains unrecorded and let the member add it later."],
    ], [27 * mm, 91 * mm, 57 * mm], True))

# 10. Opportunities
story += section("10. Work, learning, and opportunity features", "From exchange to application")
story.append(p("relayskills is larger than a peer-to-peer matching screen. It contains multiple opportunity surfaces, each with a different level of commitment. The design should distinguish browsing, proposing, applying, scheduling, and completing so that a member does not mistake an idea, listing, or workshop for a guaranteed outcome.", "Body"))
story.append(table(
    ["Feature", "Product role", "Visual and interaction notes"],
    [
        ["relayskills Tasks", "Members exchange useful work and practical tasks rather than only lessons.", "Use compact job cards, categories, proposals, clear task status, and a strong link to portfolio proof."],
        ["Marketplace", "Members exchange credits for focused help, templates, and practical sessions.", "Make price-in-credits, delivery format, and seller/member identity explicit."],
        ["Workshops", "Scheduled group learning with a real host and registration state.", "Date, timezone, host, capacity, status, and registration should be visible in the first card view."],
        ["Courses and Learning Paths", "Organize recorded opportunities and self-directed goals without pretending that an enrollment record exists.", "Use honest empty states, goal prompts, and journal links."],
        ["Innovation Lab", "Members publish ideas, seek collaboration, and move concepts toward proof, support, and recognition.", "Use proposal status, review state, support requests, and clear caveats about funding."],
        ["Funding Hub", "Helps ideas move from attention to actual support.", "Show need, support type, submissions, and decision status; never imply guaranteed funding."],
        ["Events and Livestreams", "Creates public moments for learning, showcasing, and real-time participation.", "Use schedule-first cards, live status, replay state, audience controls, and moderation affordances."],
    ], [30 * mm, 72 * mm, 73 * mm], True))

# 11. Community
story += section("11. Community, media, and social learning", "Participation layer")
story.append(p("The community layer turns relayskills from a utility into a place people return to. It includes a feed, stories, groups, forums, livestreams, challenges, skill battles, leaderboards, testimonials, and success stories. The brand should make these areas feel connected to learning, not like a separate social network competing with the core exchange.", "Body"))
story.append(two_cards(
    card("Community feed", "Member posts, stories, comments, media upload, profile previews, and discover surfaces. Provide clear privacy and reporting controls around every contribution.", PALE_TEAL, TEAL),
    card("Groups and forums", "Longer-lived circles and conversations organized by interest, skill, or goal. Give each group a clear purpose, activity signal, and moderation path.", PALE_BLUE, SKY),
))
story.append(Spacer(1, 8))
story.append(two_cards(
    card("Live participation", "Livestream directory, live room, chat, signaling, participant state, and session room handoff. Live status should be unmistakable and reversible.", PALE_CORAL, CORAL),
    card("Progress in public", "Challenges, skill battles, achievements, leaderboards, testimonials, and stories. Use optional visibility and avoid turning all learning into a ranking.", PALE_VIOLET, VIOLET),
))
story.append(Spacer(1, 10))
story.append(callout("Healthy social design", "Default to contribution over performance. Leaderboards can celebrate time shared, but the primary home view should prioritize people, conversation, and the next helpful action. Use mute, report, block, privacy, and moderation pathways as first-class controls.", PALE_CORAL, CORAL))

# 12. Organization/admin
story += section("12. Organization accounts and administration", "Trust and operations")
story.append(p("The organization experience gives a private learning community its own registration and management surface. It includes organization creation, owner details, policy settings, member listings, organization activity, and safe member account recovery. The administration experience then provides a protected checkpoint and an operations dashboard with distinct queues.", "Body"))
story.append(table(
    ["Role", "Capabilities", "Important boundary"],
    [
        ["Organization owner", "Create organization, manage policy, review members, see organization activity, and reset a member password through a one-time temporary credential.", "Owner can help a member regain access but cannot view the member's original password."],
        ["Member", "Use the shared platform, manage own profile, participate in the organization community, and follow organization policy.", "Members do not change other accounts or see protected administration data."],
        ["Administrator", "Review overview, members, account creation, messages, newsletter, support, reports, disputes, submissions, ideas, activity, ledger, sessions, and audit records.", "Administrator access is separate from normal member access and should be audited."],
        ["Moderator / safety operator", "Review complaints, reports, disputes, student safety and trust signals.", "Use least privilege and preserve an audit trail for changes."],
    ], [31 * mm, 92 * mm, 52 * mm], True))
story.append(Spacer(1, 9))
story.append(p("Admin dashboard information architecture", "Subsection"))
story.extend(bullets([
    "Overview: operational counters, engagement, risk signals, and a short list of items requiring attention.",
    "Members: searchable records, profile details, account status, suspension/verification controls, and safe reset action.",
    "Create account: administrator-assisted account creation with policy validation and a protected output state.",
    "Messages and support: review member requests and route them to the appropriate human response.",
    "Safety reports, disputes, submissions, innovation review: queue-based work with status, assignee, decision, and notes.",
    "Activity, ledger, sessions, audit: evidence-based history for trust, credits, scheduling, and accountability.",
], "Body"))

# 13. Security & privacy
story += section("13. Privacy, safety, and technical trust model", "Non-negotiable foundations")
story.append(p("The website's trust model is visible in both the interface and the backend. Accounts use protected sessions and hashed passwords; public endpoints return redacted identity fields; member records are separated from administrator controls; and child accounts use stronger defaults. relayskills should keep this architecture and make it easier to understand in plain language.", "Body"))
story.append(table(
    ["Control", "Behavior to document", "User-facing explanation"],
    [
        ["Password storage", "Use salted PBKDF2 hashing with a high iteration count; never return a password or hash through normal API responses.", "We can verify your password, but we cannot read it back. If you forget it, use a reset."],
        ["Sessions", "Use protected session cookies, logout, expiry, and session invalidation after account recovery.", "Resetting access signs out existing sessions for your protection."],
        ["CSRF / request integrity", "Issue and validate CSRF tokens for state-changing requests.", "Sensitive actions require a current secure browser session."],
        ["Child safety", "Store guardian consent state, limit location visibility, and route innovation access for review.", "Young members get safer defaults and clearer adult consent steps."],
        ["Privacy controls", "Profile visibility, location display, matching visibility, notification settings, and account cleanup.", "You choose what is public, what helps matching, and what stays private."],
        ["Auditability", "Record administrative and important account changes with actor, action, target, and timestamp.", "Safety and account changes are reviewable by the service team."],
        ["Media storage", "Validate upload types and use managed object storage for photos and community media.", "Uploaded media follows platform rules and can be removed through the correct owner or moderation path."],
    ], [32 * mm, 82 * mm, 61 * mm], True))
story.append(Spacer(1, 9))
story.append(callout("Password policy note", "The current implementation accepts a six-character minimum with uppercase, lowercase, a number, and a symbol because that was requested. For a public launch, relayskills should strongly consider a longer passphrase minimum, breached-password screening, rate limiting, and recovery through verified contact methods.", PALE_CORAL, CORAL))

# 14. Page-by-page catalog
story += section("14. Complete page catalog", "Route inventory")
story.append(p("The following inventory describes the current website's page families and the role each route should play after the relayskills rebrand. Several pages are intentionally honest about unavailable or unrecorded data; that behavior should remain because fabricated metrics damage trust.", "Body"))
catalog_rows = [
    ["Home / index.html", "SwapLabs home", "Mission, hero, first skill action, proof, and discovery routes."],
    ["about.html", "Our story", "Mission, history, impact metrics, and why open learning matters."],
    ["how-it-works.html", "How exchange works", "Profile, match, conversation, session, record."],
    ["browse-skills.html", "Browse skills", "Skill discovery and category navigation."],
    ["skill-matching.html", "Skill matching", "Structured match request and reasons."],
    ["skill-assessments.html", "Skill assessments", "Small concept checks with honest result states."],
    ["skill-battle.html", "Skill battle", "Practice and feedback in public or private modes."],
    ["mentors.html / become-a-mentor.html", "Mentor ecosystem", "Find mentors or apply to teach."],
    ["workshops.html / live-sessions.html", "Scheduled learning", "Hosted sessions, registration, and attendance context."],
    ["livestreams.html / video-room.html / session-room.html", "Real-time rooms", "Live directory, chat, video, room checks, and handoff."],
    ["courses.html / learning-paths.html", "Self-directed learning", "Recorded opportunities, goals, and journal links."],
    ["dashboard.html", "Member dashboard", "Summary, next action, matches, analytics, and onboarding."],
    ["profile.html / portfolio.html / member-profile.html", "Identity and proof", "Profile data, portfolio builder, public member view."],
    ["learning-journal.html / achievements.html", "Recorded progress", "Reflection, pins, and evidence."],
    ["calendar.html / notifications.html", "Coordination", "Availability, events, chats, requests, and notifications."],
    ["credits.html / gifts.html / rewards.html", "Value ledger", "Time credits, vouchers, gifts, redemption, and rewards."],
    ["swapjobs.html / marketplace.html", "Practical exchange", "Tasks, listings, proposals, delivery, and credit pricing."],
    ["community.html / forums.html / groups.html", "Community", "Feed, discussions, circles, media, and moderation."],
    ["community-challenges.html / leaderboards.html / success-stories.html", "Participation", "Challenges, optional rankings, and member stories."],
    ["skill-innovation.html / projects.html / funding-hub.html", "Ideas and support", "Publish ideas, invite collaboration, and request support."],
    ["events.html / blog.html / resources.html", "Public content", "Scheduled events, articles, and resources that exist."],
    ["phonebook.html / talent-directory.html", "Directories", "Feature map and people by listed skills."],
    ["register.html / login.html", "Access", "Account creation and sign-in."],
    ["organization.html / organization-admin.html", "Organization accounts", "Private community creation and member management."],
    ["admin-gate.html / admin.html / moderation-center.html", "Operations", "Protected administration, queues, trust, safety, and audit."],
    ["contact.html / complaint.html / feedback.html / report.html", "Human support", "Contact, complaints, feedback, and safety reporting."],
    ["pricing.html / donate.html / partner-with-us.html", "Sustainability", "Pricing status, support, donations, and collaboration."],
    ["privacy.html / terms.html / student-safety.html / site-credits.html", "Trust content", "Policies, child safety, and acknowledgements."],
]
story.append(table(["Current route(s)", "relayskills label", "Description"], catalog_rows, [49 * mm, 42 * mm, 84 * mm], True))

# 15. Responsive and accessibility
story += section("15. Responsive, accessibility, and content behavior", "Quality baseline")
story.append(table(
    ["Breakpoint / state", "Expected behavior", "Design decision"],
    [
        ["Large desktop", "Floating header, split heroes, 3-4 column grids, side-by-side forms, stat strips.", "Use whitespace for confidence; keep main content within a readable max width."],
        ["Tablet", "Condense nav, reduce grid columns, keep primary action visible, stack narrow side panels.", "Do not simply shrink desktop; change hierarchy and preserve touch targets."],
        ["Mobile", "Compact header, stacked hero, one-column cards, full-width forms, horizontally scrollable chips where needed.", "Keep the first action and status visible without making users hunt."],
        ["Keyboard", "Visible focus rings, logical tab order, buttons with labels, and no focus trap outside dialogs.", "Every action must work without a pointer."],
        ["Screen reader", "Semantic headings, labels, live status regions, descriptive link text, meaningful empty states.", "Announce state changes without repeating decorative copy."],
        ["Reduced motion", "Disable lifts, large reveals, autoplay, and non-essential transitions.", "Respect user preferences at the token and component layers."],
        ["High contrast / dark mode", "Keep surfaces and text paired; do not rely on color alone for status.", "Test tables, forms, avatars, badges, charts, and admin queues in both themes."],
        ["Long content", "Wrap titles, avoid clipped buttons, keep help text readable, and use tables that can scroll or stack.", "Content is a design input, not an edge case."],
    ], [32 * mm, 90 * mm, 53 * mm], True))
story.append(Spacer(1, 9))
story.append(callout("relayskills accessibility tone", "The interface should feel calm, not childish; clear, not clinical; and supportive, not patronizing. Use plain language, explain consequences before destructive actions, and let people recover from mistakes.", PALE_TEAL, TEAL))

# 16. Content system and naming
story += section("16. Rebrand content and naming system", "relayskills voice")
story.append(p("The name change should reach beyond the logo. Every title, placeholder, helper sentence, empty state, notification, and legal reference should use relayskills consistently. The voice should be direct and encouraging, with concrete verbs and an honest distinction between what is live, what is planned, and what is user-recorded.", "Body"))
story.append(table(
    ["Existing concept", "relayskills naming", "Copy direction"],
    [
        ["relayskills", "relayskills", "A place to exchange skills, time, and practical help."],
        ["Start an exchange", "Start an exchange", "Make the action understandable to a first-time visitor."],
        ["Skills", "Skills and interests", "Show both what a member can share and what they want to explore."],
        ["relayskills Task", "relayskills Task", "A practical request or offer that can become real work."],
        ["Community", "Circles", "Use 'Community' for the overall network and 'Circles' for bounded groups."],
        ["Credits", "Time credits", "Explain that the unit records contribution time, not money by default."],
        ["Admin", "relayskills operations", "Keep 'administrator' in security language; use 'operations' for the workspace."],
    ], [42 * mm, 44 * mm, 89 * mm], True))
story.append(Spacer(1, 10))
story.append(two_cards(
    card("Use", "Find, offer, teach, learn, connect, schedule, reflect, share, record, review, support, and continue.", PALE_TEAL, TEAL),
    card("Avoid", "Promise, guaranteed, instant, perfect match, unlimited, anonymous, or any statement that implies a record exists without evidence.", PALE_CORAL, CORAL),
))

# 17. Launch checklist
story += section("17. relayskills launch and implementation checklist", "From specification to build")
story.append(table(
    ["Workstream", "Definition of done", "Priority"],
    [
        ["Brand migration", "Every visible relayskills label, title, footer, alt text, metadata value, legal reference, and social share string maps to relayskills / relayskills.com.", "P0"],
        ["Theme tokens", "New color, type, radius, shadow, motion, focus, and dark-mode tokens are centralized and reused by all pages.", "P0"],
        ["Navigation", "Explore menu groups the whole product; header remains usable at desktop, tablet, and mobile widths.", "P0"],
        ["Core journey", "A test member can register, complete profile, find a match, message, schedule, open a room, record a session, and view credits.", "P0"],
        ["Safety", "Child flow, guardian consent, report, complaint, moderation, privacy, and audit states are understandable and testable.", "P0"],
        ["Data honesty", "Empty, loading, unavailable, private, and error states are explicit; no placeholder metrics are presented as facts.", "P0"],
        ["Operations", "Admin and organization owners have role-limited controls, safe password reset, audit coverage, and no plaintext credential access.", "P0"],
        ["Accessibility", "Keyboard, screen reader, contrast, focus, reduced motion, and responsive checks pass for shared components and critical flows.", "P1"],
        ["Content", "Help, FAQ, policies, onboarding, and notification copy use consistent relayskills language and explain consequences.", "P1"],
        ["Performance", "Public content is cached safely, authenticated responses are not publicly cached, and media uploads are validated.", "P1"],
        ["QA", "Visual regression screenshots cover home, discovery, login/register, dashboard, community, portfolio, organization, and admin surfaces in both themes.", "P1"],
    ], [35 * mm, 109 * mm, 31 * mm], True))

# 18. Closing
story += section("18. Closing product direction", "The feeling to preserve")
story.append(p("The strongest version of relayskills is not the one with the most pages visible at once. It is the one that makes the relationship between a person's intention and their next useful action feel obvious. A visitor should understand the invitation. A member should understand what to do next. A mentor should understand how to contribute. An organization owner should understand what they control. An administrator should understand what needs attention and why.", "Lead"))
story.append(p("The rebrand should therefore be more than a color swap. It should turn the existing breadth into a coherent story: warm discovery, structured exchange, real coordination, visible progress, and trustworthy operations. Sea Glass + Sunlit Coral gives that story a recognizable visual home while preserving the product's most valuable principle: learning becomes more powerful when it moves between people.", "Body"))
story.append(Spacer(1, 12))
story.append(callout("Target brand statement", "relayskills is where people exchange what they know, make room for what they want to learn, and turn small acts of help into a lasting community.", PALE_TEAL, TEAL))


doc = SpecDocTemplate(str(OUTPUT), title="relayskills - Website Product and Design Specification", author="OpenAI")
doc.build(story)
print(OUTPUT)
