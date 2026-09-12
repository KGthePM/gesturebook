#!/usr/bin/env python3
"""Generate sample.pdf (8 pages, big page numbers) with no external deps.

Hand-rolled minimal PDF 1.4 so Kyle can test GestureBook immediately.
Run from the app directory:  python3 generate_sample.py
"""
import os

PAGES = 8
W, H = 612, 792  # US Letter points

def content(i):
    return (
        f"BT /F1 160 Tf 260 380 Td ({i}) Tj ET "
        f"BT /F1 18 Tf 190 300 Td (GestureBook sample page {i} of {PAGES}) Tj ET "
        f"0.85 0.85 0.85 RG 3 w 40 40 {W-80} {H-80} re S"
    ).encode()

objs = []
objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")
kids = " ".join(f"{5 + 2*(i-1)} 0 R" for i in range(1, PAGES + 1))
objs.append(f"<< /Type /Pages /Kids [{kids}] /Count {PAGES} >>".encode())
objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
for i in range(1, PAGES + 1):
    c = content(i)
    objs.append(b"<< /Length %d >>\nstream\n%s\nendstream" % (len(c), c))
    objs.append(
        f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {W} {H}] "
        f"/Resources << /Font << /F1 3 0 R >> >> /Contents {4 + 2*(i-1)} 0 R >>".encode()
    )

out = bytearray(b"%PDF-1.4\n")
offsets = [0]
for idx, body in enumerate(objs, start=1):
    offsets.append(len(out))
    out += b"%d 0 obj\n" % idx + body + b"\nendobj\n"
xref_pos = len(out)
n = len(objs) + 1
out += b"xref\n0 %d\n" % n
out += b"0000000000 65535 f \n"
for off in offsets[1:]:
    out += b"%010d 00000 n \n" % off
out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (n, xref_pos)

path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sample.pdf")
with open(path, "wb") as f:
    f.write(bytes(out))
print(f"wrote {path} ({len(out)} bytes, {PAGES} pages)")
