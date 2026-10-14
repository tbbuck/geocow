# OSTN15 — source and licence

The files in this directory are Ordnance Survey's **OSTN15** transformation
between ETRS89 and OSGB36 (British National Grid), in NTv2 format, together
with OS's published validation points TP01–TP40:

| File | What |
|---|---|
| `OSTN15_NTv2_OSGBtoETRS.gsb` | The NTv2 grid geocow uses (forward for OSGB36 → ETRS89, inverted for the reverse) |
| `OSTN15_NTv2_*_Header.txt` | NTv2 header dumps |
| `OSTN15_TestInput_*.txt` / `OSTN15_TestOutput_*.txt` | OS reference points, used by the test suite |

**Source:** Ordnance Survey, OSTN15 NTv2 files —
<https://www.ordnancesurvey.co.uk/documents/resources/OSTN15-NTv2.zip>
(linked from OS's [developer page](https://www.ordnancesurvey.co.uk/products/os-net/for-developers)).

**Copyright:** © Crown copyright 2016, Ordnance Survey.

**Licence:** OS releases OSTN15 under the BSD licence; PROJ redistributes the
same grid in [PROJ-data](https://github.com/OSGeo/PROJ-data) (`uk_os/`) as
"The 2-Clause BSD License". That licence, as it applies to these files:

```
Copyright (c) 2016, Ordnance Survey. Crown copyright.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.
```

The Docker image bakes in the `.gsb`; this notice ships with it.
