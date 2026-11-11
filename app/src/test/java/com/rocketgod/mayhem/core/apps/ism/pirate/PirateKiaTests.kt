// ProtoPirate Kia decoders (V0, V1, V3/V4, V5, V6, V7) checked against the C golden fixtures.
package com.rocketgod.mayhem.core.apps.ism.pirate

import org.junit.Test

class PirateKiaTests {
    @Test fun kiaV0() = PPFixture.check("kia_v0") { PPKiaV0() }
    @Test fun kiaV1() = PPFixture.check("kia_v1") { PPKiaV1() }
    @Test fun kiaV3V4() = PPFixture.check("kia_v3_v4") { PPKiaV3V4() }
    @Test fun kiaV5() = PPFixture.check("kia_v5") { PPKiaV5() }
    @Test fun kiaV6() = PPFixture.check("kia_v6") { PPKiaV6() }
    @Test fun kiaV7() = PPFixture.check("kia_v7") { PPKiaV7() }
}
