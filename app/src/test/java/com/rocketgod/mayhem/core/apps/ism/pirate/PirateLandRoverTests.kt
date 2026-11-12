// Land Rover FSK checked against pulses cut from a recording of a real fob (resources/pirate/land_rover_fsk.txt). The
// expected lines come from an independent decode of the same recording, not from ProtoPirate's C.
package com.rocketgod.mayhem.core.apps.ism.pirate

import org.junit.Test

class PirateLandRoverTests {
    @Test fun landRoverFsk() = PPFixture.check("land_rover_fsk") { PPLandRoverFsk() }
}
