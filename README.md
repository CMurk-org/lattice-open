# Lattice Open

**Cellular evidence interoperability toolkit** — parse, normalize, validate, preserve, verify.

Copyright (c) 2026 Alvand Kiumarsi · Published by CMurk · [MPL-2.0](LICENSE)

---

Carrier records arrive in as many shapes as there are carriers, and every tool
that reads them reinvents the same fragile layer: which column is the IMSI, what
timezone the timestamps are in, whether that spreadsheet cell is a date or a
string. Getting it wrong is not a formatting bug — it shifts an entire
production by hours, or silently maps telephone numbers into a subscriber field.

This is that layer, published so it can be shared, audited and corrected in the
open.

## Scope

| | |
|---|---|
| **Schema** | The normalized cellular-record model, evidence layers, provenance references |
| **Parsers** | Carrier formats as declarative definitions — a schema fingerprint plus a field map |
| **Ingestion** | CSV, TSV, TXT, XLSX (one table per sheet), JSON, ZIP with archive safety limits |
| **Validation** | IMEI/IMSI/MSISDN structure and check digits, quality flagging that never rewrites a value |
| **Integrity** | SHA-256 hashing, evidence manifest format, standalone verification |
| **Geodesy** | WGS-84 distance, bearing and destination-point maths |
| **Export** | Conversion of normalized records to portable formats, caveats carried inside the file |
| **Fixtures** | Reproducible synthetic datasets with known ground truth |

## What is deliberately not here

Correlation, location estimation, pattern detection, scoring, findings and
report generation are a separate proprietary work. This repository is the
part whose value comes from being shared: if two systems read the same carrier
production, they should agree on what it says.

## Principles

- **The original is never modified.** A failed checksum, an impossible duration
  or an out-of-range value becomes a flag an analyst reviews, with the original
  value preserved beside it.
- **Nothing is silently guessed.** An unrecognised format produces a mapping
  proposal with its reasoning, for a human to approve.
- **Timezones are declared, not assumed.** A production whose zone is stated
  only in the cover letter cannot be imported until someone says what it is.
- **A sector observation is not a position.** Nothing here converts one into a
  coordinate, and the schema has no field that would let it.

## Contributing

Carrier format support is the point. See [CONTRIBUTING.md](CONTRIBUTING.md).

Parsers are data, not code: adding a carrier is a definition, not a rewrite.

## Status

Scaffolding. Source lands as the interoperability layer is separated from the
application it was built inside. Parsers here are calibrated against synthetic
data and are marked as such — each needs validating against genuine productions
from that carrier before operational reliance.
