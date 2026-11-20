Comparison: node-react-baseline (A) → rust-solid (B). Milliseconds; ratio B/A (<1 is faster).
| Action | Profile | A median | B median | B/A | A req / KB | B req / KB |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| cold_start | local | 174.8 | 182.9 | 1.05 | 6.0 / 595.0 | 6.0 / 422.0 |
| cold_start | lan | 240.5 | 184.8 | 0.77 | 6.0 / 595.1 | 6.0 / 422.1 |
| cold_start | broadband | 459.2 | 408.8 | 0.89 | 6.0 / 595.1 | 6.0 / 422.2 |
| cold_start | far | 963.9 | 869.7 | 0.90 | 6.0 / 595.1 | 6.0 / 422.2 |
| cold_start | mobile | 2281.5 | 1972.5 | 0.86 | 6.0 / 595.1 | 6.0 / 422.1 |
| inbox_load | local | 82.7 | 110.7 | 1.34 | 6.0 / 77.1 | 6.0 / 75.4 |
| inbox_load | lan | 164.9 | 115.0 | 0.70 | 6.0 / 77.1 | 6.0 / 75.5 |
| inbox_load | broadband | 315.6 | 249.7 | 0.79 | 6.0 / 77.2 | 6.0 / 75.5 |
| inbox_load | far | 698.6 | 540.2 | 0.77 | 6.0 / 77.2 | 6.0 / 75.5 |
| inbox_load | mobile | 1396.9 | 1074.9 | 0.77 | 6.0 / 77.2 | 6.0 / 75.4 |
| open_email | local | 71.2 | 60.9 | 0.86 | 3.0 / 119.7 | 6.0 / 191.5 |
| open_email | lan | 121.8 | 80.0 | 0.66 | 2.0 / 66.5 | 2.0 / 65.2 |
| open_email | broadband | 193.9 | 185.4 | 0.96 | 2.0 / 68.2 | 2.0 / 132.7 |
| open_email | far | 396.5 | 393.6 | 0.99 | 2.0 / 75.8 | 2.0 / 103.1 |
| open_email | mobile | 790.1 | 759.7 | 0.96 | 2.0 / 73.4 | 2.0 / 73.3 |
| next_email | local | 60.8 | 44.0 | 0.72 | 2.0 / 95.3 | 2.0 / 95.2 |
| next_email | lan | 93.8 | 76.3 | 0.81 | 2.0 / 64.1 | 2.0 / 64.0 |
| next_email | broadband | 177.3 | 175.1 | 0.99 | 2.0 / 69.2 | 2.0 / 91.9 |
| next_email | far | 392.0 | 376.4 | 0.96 | 2.0 / 95.3 | 2.0 / 102.5 |
| next_email | mobile | 861.2 | 776.3 | 0.90 | 2.0 / 118.5 | 2.0 / 84.7 |
| archive | local | 28.6 | 32.4 | 1.13 | 1.0 / 1.2 | 5.0 / 129.9 |
| archive | lan | 29.5 | 29.6 | 1.00 | 1.0 / 1.2 | 2.0 / 33.6 |
| archive | broadband | 29.2 | 28.5 | 0.98 | 0.0 / 0.0 | 0.0 / 0.0 |
| archive | far | 29.2 | 28.9 | 0.99 | 0.0 / 0.0 | 0.0 / 0.0 |
| archive | mobile | 28.5 | 28.8 | 1.01 | 0.0 / 0.0 | 0.0 / 0.0 |
| search_rare | local | 46.2 | 46.5 | 1.01 | 1.0 / 23.8 | 1.0 / 23.7 |
| search_rare | lan | 62.4 | 49.5 | 0.79 | 1.0 / 23.8 | 1.0 / 23.7 |
| search_rare | broadband | 112.3 | 97.1 | 0.86 | 1.0 / 23.8 | 1.0 / 23.7 |
| search_rare | far | 210.1 | 191.4 | 0.91 | 1.0 / 23.8 | 1.0 / 23.7 |
| search_rare | mobile | 376.5 | 362.9 | 0.96 | 1.0 / 23.8 | 1.0 / 23.7 |
| search_common | local | 127.3 | 62.5 | 0.49 | 1.0 / 69.4 | 1.0 / 69.4 |
| search_common | lan | 64.2 | 66.9 | 1.04 | 1.0 / 69.4 | 1.0 / 69.4 |
| search_common | broadband | 112.5 | 106.5 | 0.95 | 1.0 / 69.4 | 1.0 / 69.4 |
| search_common | far | 229.3 | 214.3 | 0.93 | 1.0 / 69.4 | 1.0 / 69.4 |
| search_common | mobile | 460.3 | 446.2 | 0.97 | 1.0 / 69.4 | 1.0 / 69.4 |
Failures (including warmups): A=5, B=6
