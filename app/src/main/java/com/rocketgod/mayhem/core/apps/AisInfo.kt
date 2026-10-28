package com.rocketgod.mayhem.core.apps

/** Lookup tables for the AIS vessel card: flag state from the MMSI's MID, ship types, navigation status, AtoN types. */
private val MID = mapOf(
    201 to "Albania", 202 to "Andorra", 203 to "Austria", 204 to "Azores", 205 to "Belgium", 206 to "Belarus", 207 to "Bulgaria",
    208 to "Vatican", 209 to "Cyprus", 210 to "Cyprus", 211 to "Germany", 212 to "Cyprus", 213 to "Georgia", 214 to "Moldova",
    215 to "Malta", 216 to "Armenia", 218 to "Germany", 219 to "Denmark", 220 to "Denmark", 224 to "Spain", 225 to "Spain",
    226 to "France", 227 to "France", 228 to "France", 229 to "Malta", 230 to "Finland", 231 to "Faroe Islands", 232 to "United Kingdom",
    233 to "United Kingdom", 234 to "United Kingdom", 235 to "United Kingdom", 236 to "Gibraltar", 237 to "Greece", 238 to "Croatia",
    239 to "Greece", 240 to "Greece", 241 to "Greece", 242 to "Morocco", 243 to "Hungary", 244 to "Netherlands", 245 to "Netherlands",
    246 to "Netherlands", 247 to "Italy", 248 to "Malta", 249 to "Malta", 250 to "Ireland", 251 to "Iceland", 252 to "Liechtenstein",
    253 to "Luxembourg", 254 to "Monaco", 255 to "Madeira", 256 to "Malta", 257 to "Norway", 258 to "Norway", 259 to "Norway",
    261 to "Poland", 262 to "Montenegro", 263 to "Portugal", 264 to "Romania", 265 to "Sweden", 266 to "Sweden", 267 to "Slovakia",
    268 to "San Marino", 269 to "Switzerland", 270 to "Czechia", 271 to "Türkiye", 272 to "Ukraine", 273 to "Russia",
    274 to "North Macedonia", 275 to "Latvia", 276 to "Estonia", 277 to "Lithuania", 278 to "Slovenia", 279 to "Serbia", 301 to "Anguilla",
    303 to "Alaska (USA)", 304 to "Antigua & Barbuda", 305 to "Antigua & Barbuda", 306 to "Curaçao / Sint Maarten", 307 to "Aruba",
    308 to "Bahamas", 309 to "Bahamas", 310 to "Bermuda", 311 to "Bahamas", 312 to "Belize", 314 to "Barbados", 316 to "Canada",
    319 to "Cayman Islands", 321 to "Costa Rica", 323 to "Cuba", 325 to "Dominica", 327 to "Dominican Republic", 329 to "Guadeloupe",
    330 to "Grenada", 331 to "Greenland", 332 to "Guatemala", 334 to "Honduras", 336 to "Haiti", 338 to "USA", 339 to "Jamaica",
    341 to "St Kitts & Nevis", 343 to "St Lucia", 345 to "Mexico", 347 to "Martinique", 348 to "Montserrat", 350 to "Nicaragua",
    351 to "Panama", 352 to "Panama", 353 to "Panama", 354 to "Panama", 355 to "Panama", 356 to "Panama", 357 to "Panama",
    358 to "Puerto Rico", 359 to "El Salvador", 361 to "St Pierre & Miquelon", 362 to "Trinidad & Tobago", 364 to "Turks & Caicos",
    366 to "USA", 367 to "USA", 368 to "USA", 369 to "USA", 370 to "Panama", 371 to "Panama", 372 to "Panama", 373 to "Panama",
    374 to "Panama", 375 to "St Vincent & Grenadines", 376 to "St Vincent & Grenadines", 377 to "St Vincent & Grenadines",
    378 to "British Virgin Islands", 379 to "US Virgin Islands", 401 to "Afghanistan", 403 to "Saudi Arabia", 405 to "Bangladesh",
    408 to "Bahrain", 410 to "Bhutan", 412 to "China", 413 to "China", 414 to "China", 416 to "Taiwan", 417 to "Sri Lanka", 419 to "India",
    422 to "Iran", 423 to "Azerbaijan", 425 to "Iraq", 428 to "Israel", 431 to "Japan", 432 to "Japan", 434 to "Turkmenistan",
    436 to "Kazakhstan", 437 to "Uzbekistan", 438 to "Jordan", 440 to "South Korea", 441 to "South Korea", 443 to "Palestine",
    445 to "North Korea", 447 to "Kuwait", 450 to "Lebanon", 451 to "Kyrgyzstan", 453 to "Macao", 455 to "Maldives", 457 to "Mongolia",
    459 to "Nepal", 461 to "Oman", 463 to "Pakistan", 466 to "Qatar", 468 to "Syria", 470 to "UAE", 471 to "UAE", 472 to "Tajikistan",
    473 to "Yemen", 475 to "Yemen", 477 to "Hong Kong", 478 to "Bosnia & Herzegovina", 501 to "Adélie Land", 503 to "Australia",
    506 to "Myanmar", 508 to "Brunei", 510 to "Micronesia", 511 to "Palau", 512 to "New Zealand", 514 to "Cambodia", 515 to "Cambodia",
    516 to "Christmas Island", 518 to "Cook Islands", 520 to "Fiji", 523 to "Cocos Islands", 525 to "Indonesia", 529 to "Kiribati",
    531 to "Laos", 533 to "Malaysia", 536 to "Northern Mariana Islands", 538 to "Marshall Islands", 540 to "New Caledonia", 542 to "Niue",
    544 to "Nauru", 546 to "French Polynesia", 548 to "Philippines", 550 to "Timor-Leste", 553 to "Papua New Guinea", 555 to "Pitcairn",
    557 to "Solomon Islands", 559 to "American Samoa", 561 to "Samoa", 563 to "Singapore", 564 to "Singapore", 565 to "Singapore",
    566 to "Singapore", 567 to "Thailand", 570 to "Tonga", 572 to "Tuvalu", 574 to "Vietnam", 576 to "Vanuatu", 577 to "Vanuatu",
    578 to "Wallis & Futuna", 601 to "South Africa", 603 to "Angola", 605 to "Algeria", 607 to "St Paul & Amsterdam", 608 to "Ascension",
    609 to "Burundi", 610 to "Benin", 611 to "Botswana", 612 to "Central African Republic", 613 to "Cameroon", 615 to "Congo",
    616 to "Comoros", 617 to "Cabo Verde", 618 to "Crozet", 619 to "Côte d’Ivoire", 620 to "Comoros", 621 to "Djibouti", 622 to "Egypt",
    624 to "Ethiopia", 625 to "Eritrea", 626 to "Gabon", 627 to "Ghana", 629 to "Gambia", 630 to "Guinea-Bissau",
    631 to "Equatorial Guinea", 632 to "Guinea", 633 to "Burkina Faso", 634 to "Kenya", 635 to "Kerguelen", 636 to "Liberia",
    637 to "Liberia", 638 to "South Sudan", 642 to "Libya", 644 to "Lesotho", 645 to "Mauritius", 647 to "Madagascar", 649 to "Mali",
    650 to "Mozambique", 654 to "Mauritania", 655 to "Malawi", 656 to "Niger", 657 to "Nigeria", 659 to "Namibia", 660 to "Réunion",
    661 to "Rwanda", 662 to "Sudan", 663 to "Senegal", 664 to "Seychelles", 665 to "St Helena", 666 to "Somalia", 667 to "Sierra Leone",
    668 to "São Tomé & Príncipe", 669 to "Eswatini", 670 to "Chad", 671 to "Togo", 672 to "Tunisia", 674 to "Tanzania", 675 to "Uganda",
    676 to "DR Congo", 677 to "Tanzania", 678 to "Zambia", 679 to "Zimbabwe", 701 to "Argentina", 710 to "Brazil", 720 to "Bolivia",
    725 to "Chile", 730 to "Colombia", 735 to "Ecuador", 740 to "Falkland Islands", 745 to "French Guiana", 750 to "Guyana",
    755 to "Paraguay", 760 to "Peru", 765 to "Suriname", 770 to "Uruguay", 775 to "Venezuela")

/** Flag state, and what kind of MMSI it is, from the digits. */
fun mmsiInfo(mmsi: Int): Pair<String?, String> {
    val s = mmsi.toString().padStart(9, '0')
    fun mid(at: Int) = MID[s.substring(at, at + 3).toInt()]
    return when {
        s.startsWith("111") -> mid(3) to "SAR aircraft"
        s.startsWith("00") -> mid(2) to "coast station"
        s.startsWith("0") -> mid(1) to "group of ships"
        s.startsWith("99") -> mid(2) to "aid to navigation"
        s.startsWith("98") -> mid(2) to "craft associated with a parent ship"
        s.startsWith("970") -> null to "AIS-SART"
        s.startsWith("972") -> null to "man overboard beacon"
        s.startsWith("974") -> null to "EPIRB"
        else -> mid(0) to "ship"
    }
}

private val HAZARD = listOf("", " · hazardous cat. A", " · hazardous cat. B", " · hazardous cat. C", " · hazardous cat. D")
private val SHIP_SPECIAL = mapOf(30 to "Fishing", 31 to "Towing", 32 to "Towing (long / wide tow)", 33 to "Dredging / underwater ops",
    34 to "Diving ops", 35 to "Military", 36 to "Sailing", 37 to "Pleasure craft", 50 to "Pilot vessel", 51 to "Search and rescue",
    52 to "Tug", 53 to "Port tender", 54 to "Anti-pollution", 55 to "Law enforcement", 56 to "Spare (local)", 57 to "Spare (local)",
    58 to "Medical transport", 59 to "Non-combatant ship")
private val SHIP_FAMILY = mapOf(2 to "Wing in ground", 4 to "High-speed craft", 6 to "Passenger", 7 to "Cargo", 8 to "Tanker", 9 to "Other")

/** AIS ship & cargo type code in words. */
fun shipTypeName(code: Int?): String {
    if (code == null || code == 0) return ""
    SHIP_SPECIAL[code]?.let { return it }
    val f = SHIP_FAMILY[code / 10] ?: return "Type $code"
    val ones = code % 10
    return f + if (ones in 1..4) HAZARD[ones] else if (ones == 9) " (no additional info)" else ""
}

private val NAV = listOf("Under way using engine", "At anchor", "Not under command", "Restricted maneuverability", "Constrained by draft",
    "Moored", "Aground", "Engaged in fishing", "Under way sailing", "Reserved (HSC)", "Reserved (WIG)", "Towing astern",
    "Pushing ahead / towing alongside", "Reserved", "AIS-SART / MOB / EPIRB active", "")
fun navStatusName(code: Int?): String = code?.let { NAV.getOrNull(it) } ?: ""

private val ATON = listOf("Unspecified", "Reference point", "RACON", "Fixed offshore structure", "Emergency wreck mark", "Light, without sectors",
    "Light, with sectors", "Leading light front", "Leading light rear", "Beacon, cardinal N", "Beacon, cardinal E", "Beacon, cardinal S",
    "Beacon, cardinal W", "Beacon, port hand", "Beacon, starboard hand", "Beacon, preferred channel port", "Beacon, preferred channel starboard",
    "Beacon, isolated danger", "Beacon, safe water", "Beacon, special mark", "Cardinal mark N", "Cardinal mark E", "Cardinal mark S",
    "Cardinal mark W", "Port hand mark", "Starboard hand mark", "Preferred channel port", "Preferred channel starboard", "Isolated danger",
    "Safe water", "Special mark", "Light vessel / LANBY / rig")
fun atonTypeName(code: Int?): String = code?.let { ATON.getOrNull(it) } ?: ""
