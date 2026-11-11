// ProtoPirate Ford and Mazda decoders checked against the C golden fixtures.
package com.rocketgod.mayhem.core.apps.ism.pirate

import org.junit.Test

class PirateFordTests {
    @Test fun fordV0() = PPFixture.check("ford_v0") { PPFordV0() }
    @Test fun fordV1() = PPFixture.check("ford_v1") { PPFordV1() }
    @Test fun fordV2() = PPFixture.check("ford_v2") { PPFordV2() }
    @Test fun fordV3() = PPFixture.check("ford_v3") { PPFordV3() }
    @Test fun mazdaV0() = PPFixture.check("mazda_v0") { PPMazdaV0() }
}
