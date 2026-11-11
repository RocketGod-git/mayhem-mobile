// ProtoPirate Honda, Subaru, Scher-Khan and StarLine decoders checked against the C golden fixtures.
package com.rocketgod.mayhem.core.apps.ism.pirate

import org.junit.Test

class PirateHondaTests {
    @Test fun hondaStatic() = PPFixture.check("honda_static") { PPHondaStatic() }
    @Test fun hondaV1() = PPFixture.check("honda_v1") { PPHondaV1() }
    @Test fun hondaV2() = PPFixture.check("honda_v2") { PPHondaV2() }
    @Test fun subaru() = PPFixture.check("subaru") { PPSubaru() }
    @Test fun scherKhan() = PPFixture.check("scher_khan") { PPScherKhan() }
    @Test fun starLine() = PPFixture.check("star_line") { PPStarLine() }
}
