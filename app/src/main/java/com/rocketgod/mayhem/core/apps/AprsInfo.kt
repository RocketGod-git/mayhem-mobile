package com.rocketgod.mayhem.core.apps

/** APRS symbol names for the station card (the common ones; anything else shows its code). */
private val PRIMARY = mapOf(
    '!' to "Police", '#' to "Digipeater", '$' to "Phone", '%' to "DX cluster", '&' to "HF gateway", '\'' to "Small aircraft",
    '(' to "Mobile satellite station", '*' to "Snowmobile", '+' to "Red Cross", '-' to "House", '.' to "X", '/' to "Red dot",
    '0' to "Circle 0", '1' to "Circle 1", '2' to "Circle 2", '3' to "Circle 3", '4' to "Circle 4", '5' to "Circle 5", '6' to "Circle 6",
    '7' to "Circle 7", '8' to "Circle 8", '9' to "Circle 9", ':' to "Fire", ';' to "Campground", '<' to "Motorcycle",
    '=' to "Railroad engine", '>' to "Car", '?' to "Server", '@' to "Hurricane", 'A' to "Aid station", 'B' to "BBS", 'C' to "Canoe",
    'E' to "Eyeball", 'F' to "Farm vehicle", 'G' to "Grid square", 'H' to "Hotel", 'I' to "TCP/IP", 'K' to "School", 'L' to "PC user",
    'M' to "Mac", 'N' to "NTS station", 'O' to "Balloon", 'P' to "Police car", 'R' to "Recreational vehicle", 'S' to "Shuttle",
    'T' to "SSTV", 'U' to "Bus", 'V' to "ATV", 'W' to "Weather service site", 'X' to "Helicopter", 'Y' to "Yacht / sailboat",
    'Z' to "Windows", '[' to "Person (jogger)", '\\' to "Triangle (DF)", ']' to "Mailbox", '^' to "Large aircraft",
    '_' to "Weather station", '`' to "Dish antenna", 'a' to "Ambulance", 'b' to "Bicycle", 'c' to "Incident command post",
    'd' to "Fire station", 'e' to "Horse", 'f' to "Fire truck", 'g' to "Glider", 'h' to "Hospital", 'i' to "IOTA island", 'j' to "Jeep",
    'k' to "Truck", 'l' to "Laptop", 'm' to "Mic-E repeater", 'n' to "Node", 'o' to "EOC", 'p' to "Rover (dog)", 'q' to "Grid square",
    'r' to "Repeater", 's' to "Ship / power boat", 't' to "Truck stop", 'u' to "Truck (18-wheeler)", 'v' to "Van", 'w' to "Water station",
    'x' to "X-APRS (Unix)", 'y' to "Yagi at QTH", 'z' to "Shelter",
)
private val ALTERNATE = mapOf(
    '!' to "Emergency", '#' to "Digipeater (overlay)", '$' to "Bank / ATM", '%' to "Power plant", '&' to "IGate", '\'' to "Crash site",
    '(' to "Cloudy", '*' to "Snow", '+' to "Church", '-' to "House (HF)", '.' to "Ambiguous", '/' to "Waypoint", '0' to "Circle (overlay)",
    '8' to "802.11 node", '9' to "Gas station", ':' to "Hail", ';' to "Park / picnic", '<' to "Advisory", '=' to "APRStt",
    '>' to "Car (overlay)", '?' to "Info kiosk", '@' to "Hurricane / tropical storm", 'A' to "Box (overlay)", 'B' to "Blowing snow",
    'C' to "Coast guard", 'D' to "Drizzle", 'E' to "Smoke", 'F' to "Freezing rain", 'G' to "Snow shower", 'H' to "Haze",
    'I' to "Rain shower", 'J' to "Lightning", 'K' to "Kenwood", 'L' to "Lighthouse", 'M' to "MARS", 'N' to "Navigation buoy",
    'O' to "Rocket", 'P' to "Parking", 'Q' to "Earthquake", 'R' to "Restaurant", 'S' to "Satellite", 'T' to "Thunderstorm", 'U' to "Sunny",
    'V' to "VORTAC", 'W' to "NWS site", 'X' to "Pharmacy", 'Y' to "Radios / devices", 'Z' to "Zone", '[' to "Wall cloud", ']' to "Mailbox",
    '^' to "Aircraft (overlay)", '_' to "Weather site", '`' to "Rain", 'a' to "ARRL / diamond", 'b' to "Blowing dust",
    'c' to "Civil defense (RACES)", 'd' to "DX spot", 'e' to "Sleet", 'f' to "Funnel cloud", 'g' to "Gale", 'h' to "Ham store",
    'i' to "Indoor node", 'j' to "Work zone", 'k' to "SUV", 'l' to "Area", 'm' to "Value sign", 'n' to "Triangle (overlay)",
    'o' to "Small circle", 'p' to "Partly cloudy", 'r' to "Restrooms", 's' to "Ship / boat (overlay)", 't' to "Tornado",
    'u' to "Truck (overlay)", 'v' to "Van (overlay)", 'w' to "Flooding", 'x' to "Wreck / obstruction", 'y' to "Skywarn",
    'z' to "Shelter (overlay)",
)

fun aprsSymbolName(table: Char?, symbol: Char?): String {
    if (symbol == null) return ""
    if (table == '/') return PRIMARY[symbol] ?: "symbol /$symbol"
    val alt = ALTERNATE[symbol] ?: "symbol \$symbol"
    return if (table != null && table != '\') "$alt ($table)" else alt
}
