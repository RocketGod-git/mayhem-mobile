package com.rocketgod.mayhem.core.hamid

/**
 * The PAPA system's repeater lists as published (their Google Sheet behind papasys.com/papa-repeaters/), read
 * 2026-11-22: a seed so PAPA repeaters are named offline; refreshed from [PAPA_ANALOG_URL] and [PAPA_DMR_URL]. The
 * same as the web's dsp/hamid/papa-seed.ts.
 */
private const val SHEET = "https://docs.google.com/spreadsheets/d/e/2PACX-1vTtPrC1lZiVXDDzC0sGm00icbuowp9OJx5aHCv0B2dOfVCDzmBNjrlc9DIHfl6Le_Z-ZxhNCFzTt4mi/pub"
const val PAPA_ANALOG_URL = "$SHEET?gid=0&single=true&output=csv"
const val PAPA_DMR_URL = "$SHEET?gid=686373902&single=true&output=csv"
val PAPA_ANALOG_CSV = """Status,NAME,Site Link,Frequency,Encode PL / DPL,Optional Decode PL / DPL,Emergency Power,Last Update
Online,PAPA 00,Simplex,144.460 s,100.0,100.0,,2026-10-20
Online,PAPA 01,Oat Mountain,446.580-,127.3,100.0,Yes,2020-05-23
Online,PAPA 02,Oat Mountain,224.400-,127.3,141.3,Yes,2021-03-01
Online,PAPA 03,Santiago,446.760-,073 DPL,073 DPL,Yes,2020-11-16
Online,PAPA 04H,Hollywood Hills,445.420-,131.8,141.3,,2023-05-01
Online,PAPA 04S,Saddle Peak,445.420-,127.3,141.3,,2020-08-12
Online,PAPA 05,Signal Peak,449.280-,127.3,141.3,,2026-05-03
Online,PAPA 06,Santa Ynez,446.760-,156.7,100.0,,2020-11-05
Online,PAPA 07,Toro Peak,447.840-,103.5,114.8,Yes,2021-05-12
Down,PAPA 08PV,Palos Verdes,445.140-,100.0,141.3,,2025-06-24
Down,PAPA 08V,Verdugo Peak,445.140-,131.8,141.3,,2023-02-13
Online,PAPA 08W,Mount Wilson,445.140-,127.3,141.3,Yes,2020-05-23
Online,PAPA 09,San Marcos,446.720-,103.5,114.8,,2020-07-23
Online,PAPA 10,Palomar,448.540-,103.5,114.8,,2020-05-23
Online,PAPA 11,Otay,447.560-,103.5,114.8,,2020-05-23
Online,PAPA 12,Otay,224.400-,103.5,114.8,,2020-05-23
Online,PAPA 13,Sunset Ridge,224.200-,127.3,141.3,,2020-05-23
Online,PAPA 14,Blue Ridge,446.580-,123.0,141.3,Yes,2020-06-02
Online,PAPA 15,Woodson,446.360-,103.5,114.8,Yes,2020-07-23
Stand Alone,PAPA 17,Members Only,,,,Yes,2020-05-23
Online,PAPA 18,Edom Hill,445.860-,103.5,114.8,,2020-05-23
Online,PAPA 19,El Paso Peak,448.880-,100.0,100.0,,2020-05-23
Online,PAPA 20,Redlands,447.000-,123.0,123.0,Yes,2020-05-23
Online,PAPA 21,Redlands,145.260-,127.3,141.3,Yes,2022-04-09
Online,PAPA 22,Pleasants Peak,446.320-,127.3,141.3,Yes,2020-05-23
Online,PAPA 23,Big Bear,449.380-,127.3,141.3,,2025-12-06
Online,PAPA 24,Elsinore Peak,446.700-,103.5,114.8,Yes,2020-05-23
Online,PAPA 25,Thousand Oaks,224.700-,156.7,100.0,,2020-05-23
Online,PAPA 26,Thousand Oaks,446.340-,156.7,100.0,,2020-05-23
Down,PAPA 27,Toro Peak,224.180-,127.3,114.8,Yes,2021-11-30
Online,PAPA 28,Needles,447.000-,127.3,141.3,,2023-10-29
Online,PAPA 29,Low Potosi,448.400-,127.3,141.3,,2021-11-22
Online,PAPA 30,South Mountain,446.360-,156.7,100.0,,2022-04-15
Online,PAPA 31,Daniel Peak,445.860-,103.5,114.8,,2026-07-11
Online,PAPA 32,Joaquin Ridge,442.600+,156.7,100.0,,2022-09-29
Online,PAPA 34,Cuesta Ridge,443.200+,156.7,100.0,,2024-01-27
Online,PAPA 35,Turquoise Mt,446.700-,127.3,141.3,,2024-01-11
Online,PAPA 36,Heaps Peak,446.980-,127.3,141.3,,2024-05-18
Online,PAPA 37,Mount Laguna,447.540-,103.5,114.8,,2024-12-11
Online,PAPA 38,Hauser Peak,446.700-,127.3,141.3,,2025-04-22
Online,PAPA 39,Mount Adelaide,442.750+,156.7,156.7,,2025-05-14
Online,PAPA 40,Black Mt.,446.580-,103.5,114.8,Yes,2025-05-29
Online,PAPA 41,Redlands,224.400-,127.3,141.3,Yes,2025-09-05
Online,PAPA Port,Portable Node,446.500 s,-none-,-none-,,2024-04-25
"""
val PAPA_DMR_CSV = """Status,NAME,Site Link,Frequency,Color Code,Emergency Power,Last Update
Online,BLU,Blue Ridge,449.740-,CC7,Yes,2020-05-23
Online,ELS,Elsinore Peak,445.720-,CC1,Yes,2020-05-23
Online,NDL,Needles Multimode,445.300-,CC3,,2021-08-30
Down,OAT,Oat Mountain,447.260-,CC1,Yes,2020-05-23
Online,ONX,Onyx Peak,449.340-,CC5,,2020-05-23
Online,OTY,Otay,447.260-,CC3,,2020-05-23
Online,PAL,Palomar,445.860-,CC1,,2020-05-23
Online,PSP,Edom Hill,446.580-,CC1,Yes,2020-05-23
Online,RED,Redlands,445.300-,CC3,Yes,2020-05-23
Online,SDL,Saddle Peak,446.080-,CC1,,2020-05-23
Online,SGO,Santiago,446.820-,CC1,Yes,2020-05-23
Online,SIG,Signal Peak,447.400-,CC1,,2020-05-23
Online,SMP,San Marcos,445.880-,CC3,,2020-05-23
Online,SUN,Sunset Ridge,449.360-,CC1,,2020-05-23
Online,SYZ,Santa Ynez,446.980-,CC1,,2020-05-23
Online,TOK,Thousand Oaks,446.320-,CC1,,2022-04-15
Online,TOR,Toro Peak,447.260-,CC5,Yes,2020-05-23
Online,WIL,Mount Wilson,447.540-,CC1,Yes,2025-09-11
Online,WUD,Woodson,445.960-,CC1,Yes,2020-05-23
"""
