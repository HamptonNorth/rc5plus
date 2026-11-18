#!/usr/bin/env python3
# =============================================================================
# File:    test/gen_vectors.py
# Version: 1.0.0
# Project: rc5plus-app — Bun web app for the Elitech RC-5+ temperature logger
#
# Generates test/vectors.json from the reference python-elitech library, so
# the JavaScript port can be checked byte-for-byte against the code that has
# been tested on a real RC-5+.
#
# Usage:
#   git clone https://github.com/pasccom/python-elitech /tmp/python-elitech
#   python3 test/gen_vectors.py /tmp/python-elitech > test/vectors.json
#
# GPL-3.0-or-later. See LICENSE.
# =============================================================================

import json
import random
import sys
import types
import warnings
from pathlib import Path

# --- Load python-elitech without its HIDParser submodule ---------------------
# device.py imports hid_parser at module level, but frames/records/parameters
# do not need it. A stub module is enough for importing the package.
stub = types.ModuleType("hid_parser")
stub.ReportDescriptor = object
stub.HIDComplianceWarning = Warning
sys.modules["hid_parser"] = stub

sys.path.insert(0, str(Path(sys.argv[1]).resolve()))
warnings.simplefilter("ignore")

from elitech.src.frames import Frame  # noqa: E402
from elitech.src.record import Record  # noqa: E402
from elitech.src.parameters import Parameters  # noqa: E402

random.seed(20261118)
Op = Frame.Operation
vectors = {"frames": [], "responses": [], "records": [], "parameters": []}

# --- Request frames ----------------------------------------------------------
frame_cases = [
    (Op.GetParameter, 0x00, 52),
    (Op.GetParameter, 0x34, 26),
    (Op.GetParameter, 0x88, 14),
    (Op.GetParameter, 0x95, 1),  # widened to (0x94, 2)
    (Op.GetRecord, 0, 6),
    (Op.GetRecord, 31998, 2),
    (Op.GetRecord, 70000, 6),  # exercises the 3rd offset byte
    (Op.SetParameter, 0x4C, bytes([0x00, 0x1E])),
    (Op.SetParameter, 0x28, bytes([26, 11, 0, 18, 15, 46, 0])),
    (Op.StopCommand, 0, b"\x00"),
    (Op.FormatCommand, 0, b"\x00"),
]
for op, offset, arg in frame_cases:
    vectors["frames"].append({
        "op": op.value,
        "offset": offset,
        "count": arg if isinstance(arg, int) else None,
        "payload": list(arg) if isinstance(arg, bytes) else None,
        "expected": list(bytes(Frame(op, offset, arg))),
    })


# --- Response parsing --------------------------------------------------------
def make_answer(op_low, offset, count, payload):
    """Build a well-formed answer frame padded to 64 bytes."""
    f = [0x33, 0xCC, 0x00, 0, op_low, 0, 0,
         (offset >> 8) & 0xFF, offset & 0xFF, (offset >> 16) & 0xFF, count] + payload
    f[3] = len(f) + 1
    f.append(sum(f) & 0xFF)
    return bytes(f + [0] * (64 - len(f)))


param_mem = [random.randrange(256) for _ in range(256)]
for offset, length in [(0x00, 52), (0x34, 26), (0x88, 14), (0x95, 1)]:
    frame = Frame(Op.GetParameter, offset, length)
    o, n = (max(0, offset - 1), 2) if length == 1 else (offset, length)
    answer = make_answer(0x03, o, n, param_mem[o:o + n])
    vectors["responses"].append({
        "op": Op.GetParameter.value, "offset": offset, "count": length,
        "answer": list(answer), "expected": list(frame.parse(answer).data),
    })

rec_bytes = [random.randrange(256) for _ in range(48)]
answer = make_answer(0x01, 12, 6, rec_bytes)
vectors["responses"].append({
    "op": Op.GetRecord.value, "offset": 12, "count": 6,
    "answer": list(answer),
    "expected": list(Frame(Op.GetRecord, 12, 6).parse(answer).data),
})

for status in (1, 0):
    answer = make_answer(0x04, 0x4C, 1, [status])
    vectors["responses"].append({
        "op": Op.SetParameter.value, "offset": 0x4C, "count": 2,
        "answer": list(answer),
        "expected": Frame(Op.SetParameter, 0x4C, b"\x00\x1e").parse(answer),
    })


# --- Records -----------------------------------------------------------------
def random_record():
    """Random record with a valid date so Python's datetime() accepts it."""
    q = 0
    q |= random.randrange(0, 60) << 48         # minute
    q |= random.randrange(0, 2048) << 37       # temperature magnitude
    q |= random.randrange(0, 24) << 32         # hour
    q |= random.randrange(1, 29) << 27         # day
    q |= random.randrange(1, 13) << 23         # month
    q |= random.randrange(20, 40) << 16        # year - 2000
    q |= random.randrange(0, 60) << 10         # second
    q |= random.randrange(0, 2) << 9           # temperature bit 10 extension
    q |= random.choice([0x00, 0x01, 0x02, 0x04, 0x08, 0x09, 0x80, 0x0C])
    return list(q.to_bytes(8, "little"))


for i in range(200):
    raw = random_record()
    protocol = 0x24 if i % 2 else 0x20
    r = Record.parse(bytes(raw), protocol)
    vectors["records"].append({
        "bytes": raw,
        "protocol": protocol,
        "time": r.time.strftime("%Y-%m-%d %H:%M:%S"),
        "temperature": r.temperature,
        "mark": bool(raw[0] & 0x01),
        "pause": r.pause,
        "stop": r.stop,
        "error": r.error,
    })
vectors["records"].append({"bytes": [0xFF] * 8, "protocol": 0x24, "empty": True})


# --- Parameter decoding ------------------------------------------------------
params = Parameters()
names = ["model", "serial-number", "firmware-version", "record-number",
         "device-capacity", "interval", "configuration-time", "device-time",
         "protocol-version", "timezone"]

for case in range(5):
    mem = [0] * 256
    mem[0x00:0x02] = [0x30, 0x05]
    mem[0x02:0x0E] = list(f"EF{case:010d}".encode())
    mem[0x1F] = 0x10 + case
    mem[0x42:0x46] = [0x00, 0x00, 0x7D, 0x00]
    mem[0x48:0x4A] = [case, 0x20 + case]
    mem[0x4C:0x4E] = [0x00, 6 * (case + 1)]
    mem[0x28:0x2F] = [26, 1 + case, 0, 10 + case, 8, 30, case]
    mem[0x88:0x8F] = [26, 11, 0, 18, 15, 46, case]
    mem[0x95] = 0x24
    mem[0x24] = [0, 1, 23, 5, 13][case]
    mem[0x2F] = [0, 0, 0, 30, 30][case]

    decoded = {}
    for n in names:
        p = params[n]
        p.parseData(bytes(mem[p.offset:p.offset + p.len]))
        decoded[n] = p._value if n in ("interval",) else str(p) if p.value is not None else None
        if n == "interval":
            decoded[n] = p.value
    vectors["parameters"].append({"memory": mem, "decoded": decoded})

# TimeSpan encoding: python-elitech value (seconds) -> bytes
p = params["interval"]
vectors["intervalEncoding"] = []
for minutes in range(1, 16):
    p.value = minutes * 60
    vectors["intervalEncoding"].append({"seconds": minutes * 60, "bytes": list(bytes(p))})

json.dump(vectors, sys.stdout, indent=1)
