const PRIMARY = {
    '!': 'Police', '#': 'Digipeater', '$': 'Phone', '%': 'DX cluster', '&': 'HF gateway', "'": 'Small aircraft', '(': 'Mobile satellite station', '*': 'Snowmobile', '+': 'Red Cross', '-': 'House', '.': 'X', '/': 'Red dot',
    '0': 'Circle 0', '1': 'Circle 1', '2': 'Circle 2', '3': 'Circle 3', '4': 'Circle 4', '5': 'Circle 5', '6': 'Circle 6', '7': 'Circle 7', '8': 'Circle 8', '9': 'Circle 9', ':': 'Fire', ';': 'Campground', '<': 'Motorcycle', '=': 'Railroad engine', '>': 'Car', '?': 'Server', '@': 'Hurricane',
    'A': 'Aid station', 'B': 'BBS', 'C': 'Canoe', 'E': 'Eyeball', 'F': 'Farm vehicle', 'G': 'Grid square', 'H': 'Hotel', 'I': 'TCP/IP', 'K': 'School', 'L': 'PC user', 'M': 'Mac', 'N': 'NTS station', 'O': 'Balloon', 'P': 'Police car', 'R': 'Recreational vehicle', 'S': 'Shuttle', 'T': 'SSTV', 'U': 'Bus', 'V': 'ATV', 'W': 'Weather service site', 'X': 'Helicopter', 'Y': 'Yacht / sailboat', 'Z': 'Windows',
    '[': 'Person (jogger)', '\\': 'Triangle (DF)', ']': 'Mailbox', '^': 'Large aircraft', '_': 'Weather station', '`': 'Dish antenna', 'a': 'Ambulance', 'b': 'Bicycle', 'c': 'Incident command post', 'd': 'Fire station', 'e': 'Horse', 'f': 'Fire truck', 'g': 'Glider', 'h': 'Hospital', 'i': 'IOTA island', 'j': 'Jeep', 'k': 'Truck', 'l': 'Laptop', 'm': 'Mic-E repeater', 'n': 'Node', 'o': 'EOC', 'p': 'Rover (dog)', 'q': 'Grid square', 'r': 'Repeater', 's': 'Ship / power boat', 't': 'Truck stop', 'u': 'Truck (18-wheeler)', 'v': 'Van', 'w': 'Water station', 'x': 'X-APRS (Unix)', 'y': 'Yagi at QTH', 'z': 'Shelter',
};
const ALTERNATE = {
    '!': 'Emergency', '#': 'Digipeater (overlay)', '$': 'Bank / ATM', '%': 'Power plant', '&': 'IGate', "'": 'Crash site', '(': 'Cloudy', '*': 'Snow', '+': 'Church', '-': 'House (HF)', '.': 'Ambiguous', '/': 'Waypoint', '0': 'Circle (overlay)', '8': '802.11 node', '9': 'Gas station', ':': 'Hail', ';': 'Park / picnic', '<': 'Advisory', '=': 'APRStt', '>': 'Car (overlay)', '?': 'Info kiosk', '@': 'Hurricane / tropical storm',
    'A': 'Box (overlay)', 'B': 'Blowing snow', 'C': 'Coast guard', 'D': 'Drizzle', 'E': 'Smoke', 'F': 'Freezing rain', 'G': 'Snow shower', 'H': 'Haze', 'I': 'Rain shower', 'J': 'Lightning', 'K': 'Kenwood', 'L': 'Lighthouse', 'M': 'MARS', 'N': 'Navigation buoy', 'O': 'Rocket', 'P': 'Parking', 'Q': 'Earthquake', 'R': 'Restaurant', 'S': 'Satellite', 'T': 'Thunderstorm', 'U': 'Sunny', 'V': 'VORTAC', 'W': 'NWS site', 'X': 'Pharmacy', 'Y': 'Radios / devices', 'Z': 'Zone',
    '[': 'Wall cloud', ']': 'Mailbox', '^': 'Aircraft (overlay)', '_': 'Weather site', '`': 'Rain', 'a': 'ARRL / diamond', 'b': 'Blowing dust', 'c': 'Civil defense (RACES)', 'd': 'DX spot', 'e': 'Sleet', 'f': 'Funnel cloud', 'g': 'Gale', 'h': 'Ham store', 'i': 'Indoor node', 'j': 'Work zone', 'k': 'SUV', 'l': 'Area', 'm': 'Value sign', 'n': 'Triangle (overlay)', 'o': 'Small circle', 'p': 'Partly cloudy', 'r': 'Restrooms', 's': 'Ship / boat (overlay)', 't': 'Tornado', 'u': 'Truck (overlay)', 'v': 'Van (overlay)', 'w': 'Flooding', 'x': 'Wreck / obstruction', 'y': 'Skywarn', 'z': 'Shelter (overlay)',
};
export function aprsSymbolName(table, symbol) {
    if (!symbol)
        return '';
    if (table === '/')
        return PRIMARY[symbol] ?? `symbol /${symbol}`;
    const alt = ALTERNATE[symbol] ?? `symbol \\${symbol}`;
    return table && table !== '\\' ? `${alt} (${table})` : alt;
}
