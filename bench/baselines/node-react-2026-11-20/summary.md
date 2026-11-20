# node-react-baseline

Milliseconds: median (p95). Failed samples excluded; see results.json. Two warmups discarded per action/profile.

| Action | local | lan | broadband | far | mobile |
| --- | ---: | ---: | ---: | ---: | ---: |
| cold_start | 174.8 (204.8) | 240.5 (262.7) | 459.2 (479.7) | 963.9 (980.9) | 2281.5 (2360.1) |
| inbox_load | 82.7 (91.2) | 164.9 (200.3) | 315.6 (319.7) | 698.6 (722.7) | 1396.9 (1403.2) |
| open_email | 71.2 (108.3) | 121.8 (159.4) | 193.9 (235.1) | 396.5 (470.5) | 790.1 (947.2) |
| next_email | 60.8 (77.4) | 93.8 (97.2) | 177.3 (223.4) | 392.0 (429.9) | 861.2 (999.0) |
| archive | 28.6 (39.5) | 29.5 (30.8) | 29.2 (30.6) | 29.2 (33.1) | 28.5 (31.4) |
| search_rare | 46.2 (54.3) | 62.4 (66.2) | 112.3 (114.9) | 210.1 (215.1) | 376.5 (380.5) |
| search_common | 127.3 (137.5) | 64.2 (82.5) | 112.5 (140.3) | 229.3 (231.4) | 460.3 (467.0) |

Median HTTP requests / transferred KB (decimal, request + response headers and encoded bodies completed by paint). In-flight responses contribute no bytes.

| Action | local | lan | broadband | far | mobile |
| --- | ---: | ---: | ---: | ---: | ---: |
| cold_start | 6.0 / 595.0 | 6.0 / 595.1 | 6.0 / 595.1 | 6.0 / 595.1 | 6.0 / 595.1 |
| inbox_load | 6.0 / 77.1 | 6.0 / 77.1 | 6.0 / 77.2 | 6.0 / 77.2 | 6.0 / 77.2 |
| open_email | 3.0 / 119.7 | 2.0 / 66.5 | 2.0 / 68.2 | 2.0 / 75.8 | 2.0 / 73.4 |
| next_email | 2.0 / 95.3 | 2.0 / 64.1 | 2.0 / 69.2 | 2.0 / 95.3 | 2.0 / 118.5 |
| archive | 1.0 / 1.2 | 1.0 / 1.2 | 0.0 / 0.0 | 0.0 / 0.0 | 0.0 / 0.0 |
| search_rare | 1.0 / 23.8 | 1.0 / 23.8 | 1.0 / 23.8 | 1.0 / 23.8 | 1.0 / 23.8 |
| search_common | 1.0 / 69.4 | 1.0 / 69.4 | 1.0 / 69.4 | 1.0 / 69.4 | 1.0 / 69.4 |

Failures: 5 (including warmups).
