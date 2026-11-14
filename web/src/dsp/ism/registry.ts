/** Every ported protocol, instantiated fresh (twin of ism/IsmProtos.kt). */
import type { FProto } from './base.js';
import { CBmwV0 } from './c-bmw_v0.js';
import { SBett } from './s-bett.js';
import { SAllstarFirefly } from './s-allstar_firefly.js';
import { SAlutechAt4n } from './s-alutech_at_4n.js';
import { SAnsonic } from './s-ansonic.js';
import { SBelkorn } from './s-belkorn.js';
import { SBenincaArc } from './s-beninca_arc.js';
import { SDickertMahs } from './s-dickert_mahs.js';
import { SDitecGol4 } from './s-ditec_gol4.js';
import { SDoorbell32 } from './s-doorbell32.js';
import { SElplast } from './s-elplast.js';
import { SFaacTm } from './s-faac_tm.js';
import { SFeron } from './s-feron.js';
import { SFreezer } from './s-freezer.js';
import { SHay21 } from './s-hay21.js';
import { SHollarm } from './s-hollarm.js';
import { SJarolift } from './s-jarolift.js';
import { SKeyfinder } from './s-keyfinder.js';
import { SKeyfinder2 } from './s-keyfinder2.js';
import { SNordIce } from './s-nord_ice.js';
import { SProteco } from './s-proteco.js';
import { SReversRb2 } from './s-revers_rb2.js';
import { SRoger } from './s-roger.js';
import { STelcomaEdge } from './s-telcoma_edge.js';
import { STreadmill37 } from './s-treadmill37.js';
import { SCame } from './s-came.js';
import { SCameAtomo } from './s-came_atomo.js';
import { SCameTwee } from './s-came_twee.js';
import { SChambcode } from './s-chambcode.js';
import { SClemsa } from './s-clemsa.js';
import { SDoitrand } from './s-doitrand.js';
import { SDooya } from './s-dooya.js';
import { SFaac } from './s-faac.js';
import { SGangqi } from './s-gangqi.js';
import { SGateTx } from './s-gate_tx.js';
import { SHoltek } from './s-holtek.js';
import { SHoltekHt12x } from './s-holtek_ht12x.js';
import { SHoltekHt6p20b } from './s-holtek_ht6p20b.js';
import { SHoneywell } from './s-honeywell.js';
import { SHoneywellWdb } from './s-honeywellwdb.js';
import { SHormann } from './s-hormann.js';
import { SIdo } from './s-ido.js';
import { SIntertechnoV3 } from './s-intertechnov3.js';
import { SKeeloq } from './s-keeloq.js';
import { SKinggatesStylo4k } from './s-kinggates_stylo_4k.js';
import { SLegrand } from './s-legrand.js';
import { SLinear } from './s-linear.js';
import { SLinearDelta3 } from './s-linear_delta3.js';
import { SMagellan } from './s-magellan.js';
import { SMarantec } from './s-marantec.js';
import { SMarantec24 } from './s-marantec24.js';
import { SMastercode } from './s-mastercode.js';
import { SMegacode } from './s-megacode.js';
import { SNeroSketch } from './s-nero_sketch.js';
import { SNeroRadio } from './s-neroradio.js';
import { SNiceFlo } from './s-nice_flo.js';
import { SNiceFlors } from './s-nice_flors.js';
import { SPhoenixV2 } from './s-phoenix_v2.js';
import { SPowerSmart } from './s-power_smart.js';
import { SPrinceton } from './s-princeton.js';
import { SRestaurantPager } from './s-restaurant_pager.js';
import { SSecplusV1 } from './s-secplus_v1.js';
import { SSecplusV2 } from './s-secplus_v2.js';
import { SSmc5326 } from './s-smc5326.js';
import { SSomfyKeytis } from './s-somify_keytis.js';
import { SSomfyTelis } from './s-somify_telis.js';
import { SStarLine } from './s-star_line.js';
import { SSuperrollo } from './s-superrollo.js';
import { SX10 } from './s-x10.js';
import { WAcurite592Txr } from './w-acurite592txr.js';
import { WAcurite5in1 } from './w-acurite5in1.js';
import { WAcurite606Tx } from './w-acurite606tx.js';
import { WAcurite609Tx } from './w-acurite609tx.js';
import { WAcurite986 } from './w-acurite986.js';
import { WAmbient } from './w-ambient.js';
import { WAuriolAhfl } from './w-auriol-ahfl.js';
import { WAuriolTh } from './w-auriol-th.js';
import { WBresser3Ch } from './w-bresser_3ch.js';
import { WEmosE601x } from './w-emose601x.js';
import { WGtWt02 } from './w-gt-wt-02.js';
import { WGtWt03 } from './w-gt-wt-03.js';
import { WInfactory } from './w-infactory.js';
import { WKedsum } from './w-kedsum.js';
import { WLacrosseTx } from './w-lacrosse-tx.js';
import { WLacrosseTx141thbv2 } from './w-lacrosse-tx141thbv2.js';
import { WNexusTh } from './w-nexus-th.js';
import { WOregon2 } from './w-oregon2.js';
import { WOregon3 } from './w-oregon3.js';
import { WOregonV1 } from './w-oregonv1.js';
import { WSolightTe44 } from './w-solight_te44.js';
import { WThermoproTx4 } from './w-thermoprotx4.js';
import { WTx8300 } from './w-tx8300.js';
import { WVaunoEn8822 } from './w-vauno_en8822.js';
import { WWendoxW6726 } from './w-wendox-w6726.js';

export function allProtos(): FProto[] {
  return [
    new CBmwV0(),
    new SBett(),
    new SCame(),
    new SCameAtomo(),
    new SCameTwee(),
    new SChambcode(),
    new SClemsa(),
    new SDoitrand(),
    new SDooya(),
    new SFaac(),
    new SGangqi(),
    new SGateTx(),
    new SHoltek(),
    new SHoltekHt12x(),
    new SHoltekHt6p20b(),
    new SHoneywell(),
    new SHoneywellWdb(),
    new SHormann(),
    new SIdo(),
    new SIntertechnoV3(),
    new SKeeloq(),
    new SKinggatesStylo4k(),
    new SLegrand(),
    new SLinear(),
    new SLinearDelta3(),
    new SMagellan(),
    new SMarantec(),
    new SMarantec24(),
    new SMastercode(),
    new SMegacode(),
    new SNeroSketch(),
    new SNeroRadio(),
    new SNiceFlo(),
    new SNiceFlors(),
    new SPhoenixV2(),
    new SPowerSmart(),
    new SPrinceton(),
    new SRestaurantPager(),
    new SSecplusV1(),
    new SSecplusV2(),
    new SSmc5326(),
    new SSomfyKeytis(),
    new SSomfyTelis(),
    new SStarLine(),
    new SSuperrollo(),
    new SX10(),
    new SAllstarFirefly(),
    new SAlutechAt4n(),
    new SAnsonic(),
    new SBelkorn(),
    new SBenincaArc(),
    new SDickertMahs(),
    new SDitecGol4(),
    new SDoorbell32(),
    new SElplast(),
    new SFaacTm(),
    new SFeron(),
    new SFreezer(),
    new SHay21(),
    new SHollarm(),
    new SJarolift(),
    new SKeyfinder(),
    new SKeyfinder2(),
    new SNordIce(),
    new SProteco(),
    new SReversRb2(),
    new SRoger(),
    new STelcomaEdge(),
    new STreadmill37(),
    new WAcurite592Txr(),
    new WAcurite5in1(),
    new WAcurite606Tx(),
    new WAcurite609Tx(),
    new WAcurite986(),
    new WAmbient(),
    new WAuriolAhfl(),
    new WAuriolTh(),
    new WBresser3Ch(),
    new WEmosE601x(),
    new WGtWt02(),
    new WGtWt03(),
    new WInfactory(),
    new WKedsum(),
    new WLacrosseTx(),
    new WLacrosseTx141thbv2(),
    new WNexusTh(),
    new WOregon2(),
    new WOregon3(),
    new WOregonV1(),
    new WSolightTe44(),
    new WThermoproTx4(),
    new WTx8300(),
    new WVaunoEn8822(),
    new WWendoxW6726(),
  ];
}
