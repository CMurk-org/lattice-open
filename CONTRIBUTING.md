# Contributing

Carrier format support is what this repository exists to accumulate.

## Adding a carrier format

Parsers are declarative: a schema fingerprint (which columns identify this
format) plus a field map (which column means what), executed by a shared
engine. You are contributing a definition, not a parser.

Include with every submission:

- The column layout, with the carrier and record type it came from
- The timezone convention, and where it is stated — in the file, or only in the
  cover letter
- A **synthetic** fixture exercising the format
- Any quirks: day-first dates, split date/time columns, sentinel values

## Never submit real evidence

No genuine carrier productions, no real IMSI/IMEI/MSISDN, no subscriber data,
no case material. Fixtures must be synthetic. A pull request containing real
investigative data will be closed without merge, and its history purged.

Describe the *shape* of a real production; supply a synthetic file that matches
it.

## Licence and provenance

Contributions are licensed under MPL-2.0. File-level copyleft: improvements to
a file here stay here, while the toolkit remains usable alongside proprietary
software.

Because carrier formats are often learned from productions obtained under legal
process, contributors are asked to confirm they have the right to contribute
what they submit and that it contains no material they are not free to publish.
A CLA covering this will be added before the first external merge.
