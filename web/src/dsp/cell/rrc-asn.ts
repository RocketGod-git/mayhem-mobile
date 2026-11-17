/** The 36.331 ASN.1 subset for BCCH-DL-SCH (system information), in the specification's own notation. */
export const RRC_ASN = `
maxSIB INTEGER ::= 32
maxSI-Message INTEGER ::= 32
maxPLMN-r11 INTEGER ::= 6
maxPLMN-1-r14 INTEGER ::= 5
maxFBI INTEGER ::= 64
maxFBI-Plus1 INTEGER ::= 65
maxFBI2 INTEGER ::= 256
maxEARFCN INTEGER ::= 65535
maxEARFCN-Plus1 INTEGER ::= 65536
maxEARFCN2 INTEGER ::= 262143
maxMultiBands INTEGER ::= 8
maxNS-Pmax-r10 INTEGER ::= 8
maxCellIntra INTEGER ::= 16
maxCellInter INTEGER ::= 16
maxCellBlack INTEGER ::= 16
maxFreq INTEGER ::= 8
maxUTRA-FDD-Carrier INTEGER ::= 16
maxUTRA-TDD-Carrier INTEGER ::= 16
maxGNFG INTEGER ::= 16
maxCDMA-BandClass INTEGER ::= 32
maxPNOffset INTEGER ::= 511
maxMBSFN-Allocations INTEGER ::= 8
maxFreqNR-r15 INTEGER ::= 8
maxMultiBandsNR-r15 INTEGER ::= 32
maxRS-Index-r15 INTEGER ::= 64
maxQuantSetsNR-r15 INTEGER ::= 2
maxMBSFN-Area INTEGER ::= 8

BCCH-DL-SCH-Message ::= SEQUENCE { message BCCH-DL-SCH-MessageType }
BCCH-DL-SCH-MessageType ::= CHOICE {
  c1 CHOICE { systemInformation SystemInformation, systemInformationBlockType1 SystemInformationBlockType1 },
  messageClassExtension SEQUENCE {}
}

SystemInformation ::= SEQUENCE {
  criticalExtensions CHOICE {
    systemInformation-r8 SystemInformation-r8-IEs,
    criticalExtensionsFuture-r15 CHOICE { posSystemInformation-r15 OCTET STRING, criticalExtensionsFuture SEQUENCE {} }
  }
}
SystemInformation-r8-IEs ::= SEQUENCE {
  sib-TypeAndInfo SEQUENCE (SIZE (1..maxSIB)) OF CHOICE {
    sib2 SystemInformationBlockType2,
    sib3 SystemInformationBlockType3,
    sib4 SystemInformationBlockType4,
    sib5 SystemInformationBlockType5,
    sib6 SystemInformationBlockType6,
    sib7 SystemInformationBlockType7,
    sib8 SystemInformationBlockType8,
    sib9 SystemInformationBlockType9,
    sib10 SystemInformationBlockType10,
    sib11 SystemInformationBlockType11,
    ...,
    sib12-v920 SystemInformationBlockType12-r9,
    sib13-v920 SystemInformationBlockType13-r9,
    sib14-v1130 SystemInformationBlockType14-r11,
    sib15-v1130 SystemInformationBlockType15-r11,
    sib16-v1130 SystemInformationBlockType16-r11,
    sib17-v1250 SystemInformationBlockType17-r12,
    sib18-v1250 SystemInformationBlockType18-r12,
    sib19-v1250 SystemInformationBlockType19-r12,
    sib20-v1310 SystemInformationBlockType20-r13,
    sib21-v1430 SystemInformationBlockType21-r14,
    sib24-v1530 SystemInformationBlockType24-r15,
    sib25-v1530 SystemInformationBlockType25-r15,
    sib26-v1530 SystemInformationBlockType26-r15,
    sib26a-v1610 SystemInformationBlockType26a-r16,
    sib27-v1610 SystemInformationBlockType27-r16,
    sib28-v1610 SystemInformationBlockType28-r16,
    sib29-v1610 SystemInformationBlockType29-r16,
    sib30-v1700 SystemInformationBlockType30-r17,
    sib31-v1700 SystemInformationBlockType31-r17,
    sib32-v1700 SystemInformationBlockType32-r17
  },
  nonCriticalExtension SystemInformation-v8a0-IEs OPTIONAL
}
SystemInformation-v8a0-IEs ::= SEQUENCE {
  lateNonCriticalExtension OCTET STRING OPTIONAL,
  nonCriticalExtension SEQUENCE {} OPTIONAL
}

SystemInformationBlockType1 ::= SEQUENCE {
  cellAccessRelatedInfo SEQUENCE {
    plmn-IdentityList PLMN-IdentityList,
    trackingAreaCode TrackingAreaCode,
    cellIdentity CellIdentity,
    cellBarred ENUMERATED {barred, notBarred},
    intraFreqReselection ENUMERATED {allowed, notAllowed},
    csg-Indication BOOLEAN,
    csg-Identity CSG-Identity OPTIONAL
  },
  cellSelectionInfo SEQUENCE {
    q-RxLevMin Q-RxLevMin,
    q-RxLevMinOffset INTEGER (1..8) OPTIONAL
  },
  p-Max P-Max OPTIONAL,
  freqBandIndicator FreqBandIndicator,
  schedulingInfoList SchedulingInfoList,
  tdd-Config TDD-Config OPTIONAL,
  si-WindowLength ENUMERATED {ms1, ms2, ms5, ms10, ms15, ms20, ms40},
  systemInfoValueTag INTEGER (0..31),
  nonCriticalExtension SystemInformationBlockType1-v890-IEs OPTIONAL
}
SystemInformationBlockType1-v890-IEs ::= SEQUENCE {
  lateNonCriticalExtension OCTET STRING (CONTAINING SystemInformationBlockType1-v8h0-IEs) OPTIONAL,
  nonCriticalExtension SystemInformationBlockType1-v920-IEs OPTIONAL
}
SystemInformationBlockType1-v8h0-IEs ::= SEQUENCE {
  multiBandInfoList MultiBandInfoList OPTIONAL,
  nonCriticalExtension SystemInformationBlockType1-v9e0-IEs OPTIONAL
}
SystemInformationBlockType1-v9e0-IEs ::= SEQUENCE {
  freqBandIndicator-v9e0 FreqBandIndicator-v9e0 OPTIONAL,
  multiBandInfoList-v9e0 MultiBandInfoList-v9e0 OPTIONAL,
  nonCriticalExtension SystemInformationBlockType1-v10j0-IEs OPTIONAL
}
SystemInformationBlockType1-v10j0-IEs ::= SEQUENCE {
  freqBandInfo-r10 NS-PmaxList-r10 OPTIONAL,
  multiBandInfoList-v10j0 MultiBandInfoList-v10j0 OPTIONAL,
  nonCriticalExtension SystemInformationBlockType1-v10l0-IEs OPTIONAL
}
SystemInformationBlockType1-v10l0-IEs ::= SEQUENCE {
  freqBandInfo-v10l0 NS-PmaxList-v10l0 OPTIONAL,
  multiBandInfoList-v10l0 MultiBandInfoList-v10l0 OPTIONAL,
  nonCriticalExtension SystemInformationBlockType1-v10x0-IEs OPTIONAL
}
SystemInformationBlockType1-v10x0-IEs ::= SEQUENCE {
  lateNonCriticalExtension OCTET STRING OPTIONAL,
  nonCriticalExtension SystemInformationBlockType1-v12j0-IEs OPTIONAL
}
SystemInformationBlockType1-v12j0-IEs ::= SEQUENCE {
  unidentified-v12j0 OCTET STRING OPTIONAL, -- one optional element precedes schedulingInfoListExt-r12 (recorded presence bits)
  schedulingInfoListExt-r12 SchedulingInfoListExt-r12 OPTIONAL,
  nonCriticalExtension SEQUENCE {} OPTIONAL
}
SystemInformationBlockType1-v920-IEs ::= SEQUENCE {
  ims-EmergencySupport-r9 ENUMERATED {true} OPTIONAL,
  cellSelectionInfo-v920 CellSelectionInfo-v920 OPTIONAL,
  nonCriticalExtension SystemInformationBlockType1-v1130-IEs OPTIONAL
}
SystemInformationBlockType1-v1130-IEs ::= SEQUENCE {
  tdd-Config-v1130 TDD-Config-v1130 OPTIONAL,
  cellSelectionInfo-v1130 CellSelectionInfo-v1130 OPTIONAL,
  nonCriticalExtension SystemInformationBlockType1-v1250-IEs OPTIONAL
}
SystemInformationBlockType1-v1250-IEs ::= SEQUENCE {
  cellAccessRelatedInfo-v1250 SEQUENCE { category0Allowed-r12 ENUMERATED {true} OPTIONAL },
  cellSelectionInfo-v1250 CellSelectionInfo-v1250 OPTIONAL,
  freqBandIndicatorPriority-r12 ENUMERATED {true} OPTIONAL,
  nonCriticalExtension SystemInformationBlockType1-v1310-IEs OPTIONAL
}
SystemInformationBlockType1-v1310-IEs ::= SEQUENCE {
  hyperSFN-r13 BIT STRING (SIZE (10)) OPTIONAL,
  eDRX-Allowed-r13 ENUMERATED {true} OPTIONAL,
  cellSelectionInfoCE-r13 CellSelectionInfoCE-r13 OPTIONAL,
  bandwidthReducedAccessRelatedInfo-r13 BandwidthReducedAccessRelatedInfo-r13 OPTIONAL,
  nonCriticalExtension SystemInformationBlockType1-v1320-IEs OPTIONAL
}
SystemInformationBlockType1-v1320-IEs ::= SEQUENCE {
  freqHoppingParametersDL-r13 FreqHoppingParametersDL-r13 OPTIONAL,
  nonCriticalExtension SystemInformationBlockType1-v1350-IEs OPTIONAL
}
SystemInformationBlockType1-v1350-IEs ::= SEQUENCE {
  cellSelectionInfoCE1-r13 CellSelectionInfoCE1-r13 OPTIONAL,
  nonCriticalExtension SystemInformationBlockType1-v1360-IEs OPTIONAL
}
SystemInformationBlockType1-v1360-IEs ::= SEQUENCE {
  cellSelectionInfoCE1-v1360 CellSelectionInfoCE1-v1360 OPTIONAL,
  nonCriticalExtension SystemInformationBlockType1-v1430-IEs OPTIONAL
}
SystemInformationBlockType1-v1430-IEs ::= SEQUENCE {
  eCallOverIMS-Support-r14 ENUMERATED {true} OPTIONAL,
  tdd-Config-v1430 TDD-Config-v1430 OPTIONAL,
  cellAccessRelatedInfoList-r14 SEQUENCE (SIZE (1..maxPLMN-1-r14)) OF CellAccessRelatedInfo-r14 OPTIONAL,
  nonCriticalExtension SystemInformationBlockType1-v1450-IEs OPTIONAL
}
SystemInformationBlockType1-v1450-IEs ::= SEQUENCE {
  tdd-Config-v1450 TDD-Config-v1450 OPTIONAL,
  nonCriticalExtension SystemInformationBlockType1-v1530-IEs OPTIONAL
}
SystemInformationBlockType1-v1530-IEs ::= SEQUENCE {
  hsdn-Cell-r15 ENUMERATED {true} OPTIONAL,
  cellSelectionInfoCE-v1530 CellSelectionInfoCE-v1530 OPTIONAL,
  crs-IntfMitigConfig-r15 CHOICE { crs-IntfMitigEnabled-15 NULL, crs-IntfMitigNumPRBs-r15 ENUMERATED {n6, n24} } OPTIONAL,
  cellBarred-CRS-r15 ENUMERATED {barred, notBarred},
  plmn-IdentityList-v1530 SEQUENCE (SIZE (1..maxPLMN-r11)) OF PLMN-IdentityInfo-v1530 OPTIONAL,
  posSchedulingInfoList-r15 OCTET STRING OPTIONAL,
  cellAccessRelatedInfo-5GC-r15 CellAccessRelatedInfo-5GC-r15 OPTIONAL,
  ims-EmergencySupport5GC-r15 ENUMERATED {true} OPTIONAL,
  eCallOverIMS-Support5GC-r15 ENUMERATED {true} OPTIONAL,
  nonCriticalExtension SEQUENCE {} OPTIONAL
}

PLMN-IdentityList ::= SEQUENCE (SIZE (1..maxPLMN-r11)) OF PLMN-IdentityInfo
PLMN-IdentityInfo ::= SEQUENCE {
  plmn-Identity PLMN-Identity,
  cellReservedForOperatorUse ENUMERATED {reserved, notReserved}
}
PLMN-IdentityInfo-v1530 ::= SEQUENCE { cellReservedForOperatorUse-CRS-r15 ENUMERATED {reserved, notReserved} }
PLMN-Identity ::= SEQUENCE { mcc MCC OPTIONAL, mnc MNC }
MCC ::= SEQUENCE (SIZE (3)) OF MCC-MNC-Digit
MNC ::= SEQUENCE (SIZE (2..3)) OF MCC-MNC-Digit
MCC-MNC-Digit ::= INTEGER (0..9)
TrackingAreaCode ::= BIT STRING (SIZE (16))
CellIdentity ::= BIT STRING (SIZE (28))
CSG-Identity ::= BIT STRING (SIZE (27))
CellAccessRelatedInfo-r14 ::= SEQUENCE {
  plmn-IdentityList-r14 PLMN-IdentityList,
  trackingAreaCode-r14 TrackingAreaCode,
  cellIdentity-r14 CellIdentity
}
CellAccessRelatedInfo-5GC-r15 ::= SEQUENCE {
  cellBarred-5GC-r15 ENUMERATED {barred, notBarred},
  cellBarred-5GC-CRS-r15 ENUMERATED {barred, notBarred},
  cellAccessRelatedInfoList-5GC-r15 SEQUENCE (SIZE (1..maxPLMN-r11)) OF CellAccessRelatedInfo-5GC-Entry-r15
}
CellAccessRelatedInfo-5GC-Entry-r15 ::= SEQUENCE {
  plmn-IdentityList-r15 SEQUENCE (SIZE (1..maxPLMN-r11)) OF PLMN-IdentityInfo-r15,
  ran-AreaCode-r15 INTEGER (0..255) OPTIONAL,
  trackingAreaCode-5GC-r15 BIT STRING (SIZE (24)),
  cellIdentity-5GC-r15 CHOICE { cellIdentity-r15 CellIdentity, cellId-Index-r15 INTEGER (1..maxPLMN-r11) }
}
PLMN-IdentityInfo-r15 ::= SEQUENCE {
  plmn-Identity-5GC-r15 CHOICE { plmn-Identity-r15 PLMN-Identity, plmn-Index-r15 INTEGER (1..maxPLMN-r11) },
  cellReservedForOperatorUse-r15 ENUMERATED {reserved, notReserved},
  cellReservedForOperatorUse-CRS-r15 ENUMERATED {reserved, notReserved}
}
Q-RxLevMin ::= INTEGER (-70..-22)
Q-QualMin-r9 ::= INTEGER (-34..-3)
P-Max ::= INTEGER (-30..33)
FreqBandIndicator ::= INTEGER (1..maxFBI)
FreqBandIndicator-v9e0 ::= INTEGER (maxFBI-Plus1..maxFBI2)
AdditionalSpectrumEmission ::= INTEGER (1..32)
AdditionalSpectrumEmission-v10l0 ::= INTEGER (33..288)
ARFCN-ValueEUTRA ::= INTEGER (0..maxEARFCN)
ARFCN-ValueEUTRA-v9e0 ::= INTEGER (maxEARFCN-Plus1..maxEARFCN2)
MultiBandInfoList ::= SEQUENCE (SIZE (1..maxMultiBands)) OF FreqBandIndicator
MultiBandInfoList-v9e0 ::= SEQUENCE (SIZE (1..maxMultiBands)) OF MultiBandInfo-v9e0
MultiBandInfo-v9e0 ::= SEQUENCE { freqBandIndicator-v9e0 FreqBandIndicator-v9e0 OPTIONAL }
MultiBandInfoList-v10j0 ::= SEQUENCE (SIZE (1..maxMultiBands)) OF NS-PmaxList-r10
MultiBandInfoList-v10l0 ::= SEQUENCE (SIZE (1..maxMultiBands)) OF NS-PmaxList-v10l0
NS-PmaxList-r10 ::= SEQUENCE (SIZE (1..maxNS-Pmax-r10)) OF NS-PmaxValue-r10
NS-PmaxValue-r10 ::= SEQUENCE {
  additionalPmax-r10 P-Max OPTIONAL,
  additionalSpectrumEmission AdditionalSpectrumEmission
}
NS-PmaxList-v10l0 ::= SEQUENCE (SIZE (1..maxNS-Pmax-r10)) OF NS-PmaxValue-v10l0
NS-PmaxValue-v10l0 ::= SEQUENCE { additionalSpectrumEmission-v10l0 AdditionalSpectrumEmission-v10l0 OPTIONAL }
SchedulingInfoList ::= SEQUENCE (SIZE (1..maxSI-Message)) OF SchedulingInfo
SchedulingInfo ::= SEQUENCE {
  si-Periodicity ENUMERATED {rf8, rf16, rf32, rf64, rf128, rf256, rf512},
  sib-MappingInfo SIB-MappingInfo
}
SIB-MappingInfo ::= SEQUENCE (SIZE (0..maxSIB-1)) OF SIB-Type
SIB-Type ::= ENUMERATED {
  sibType3, sibType4, sibType5, sibType6, sibType7, sibType8, sibType9, sibType10, sibType11, sibType12-v920,
  sibType13-v920, sibType14-v1130, sibType15-v1130, sibType16-v1130, sibType17-v1250, sibType18-v1250, ...,
  sibType19-v1250, sibType20-v1310, sibType21-v1430, sibType24-v1530, sibType25-v1530, sibType26-v1530,
  sibType26a-v1610, sibType27-v1610, sibType28-v1610, sibType29-v1610, sibType30-v1700, sibType31-v1700, sibType32-v1700
}
SchedulingInfoListExt-r12 ::= SEQUENCE (SIZE (1..maxSI-Message)) OF SchedulingInfoExt-r12
SchedulingInfoExt-r12 ::= SEQUENCE {
  si-Periodicity-r12 ENUMERATED {rf8, rf16, rf32, rf64, rf128, rf256, rf512},
  sib-MappingInfo-r12 SIB-MappingInfo-v12j0
}
SIB-MappingInfo-v12j0 ::= SEQUENCE (SIZE (1..maxSIB)) OF SIB-Type-v12j0
SIB-Type-v12j0 ::= ENUMERATED {
  sibType19-v1250, sibType20-v1310, sibType21-v1430, sibType24-v1530, sibType25-v1530, sibType26-v1530,
  sibType26a-v1610, sibType27-v1610, sibType28-v1610, sibType29-v1610, sibType30-v1700, sibType31-v1700,
  sibType32-v1700, spare3, spare2, spare1, ...
}
TDD-Config ::= SEQUENCE {
  subframeAssignment ENUMERATED {sa0, sa1, sa2, sa3, sa4, sa5, sa6},
  specialSubframePatterns ENUMERATED {ssp0, ssp1, ssp2, ssp3, ssp4, ssp5, ssp6, ssp7, ssp8}
}
TDD-Config-v1130 ::= SEQUENCE { specialSubframePatterns-v1130 ENUMERATED {ssp7, ssp9} }
TDD-Config-v1430 ::= SEQUENCE { specialSubframePatterns-v1430 ENUMERATED {ssp10} }
TDD-Config-v1450 ::= SEQUENCE { specialSubframePatterns-v1450 ENUMERATED {ssp10-CRS-LessDwPTS} }
CellSelectionInfo-v920 ::= SEQUENCE {
  q-QualMin-r9 Q-QualMin-r9,
  q-QualMinOffset-r9 INTEGER (1..8) OPTIONAL
}
CellSelectionInfo-v1130 ::= SEQUENCE { q-QualMinWB-r11 Q-QualMin-r9 }
CellSelectionInfo-v1250 ::= SEQUENCE { q-QualMinRSRQ-OnAllSymbols-r12 Q-QualMin-r9 }
CellSelectionInfoCE-r13 ::= SEQUENCE {
  q-RxLevMinCE-r13 Q-RxLevMin,
  q-QualMinRSRQ-CE-r13 Q-QualMin-r9 OPTIONAL
}
CellSelectionInfoCE-v1530 ::= SEQUENCE { powerClass14dBm-Offset-r15 ENUMERATED {dB-6, dB-3, dB3, dB6, dB9, dB12} }
CellSelectionInfoCE1-r13 ::= SEQUENCE {
  q-RxLevMinCE1-r13 Q-RxLevMin,
  q-QualMinRSRQ-CE1-r13 Q-QualMin-r9 OPTIONAL
}
CellSelectionInfoCE1-v1360 ::= SEQUENCE { delta-RxLevMinCE1-v1360 INTEGER (-8..-1) }

SystemInformationBlockType2 ::= SEQUENCE {
  ac-BarringInfo SEQUENCE {
    ac-BarringForEmergency BOOLEAN,
    ac-BarringForMO-Signalling AC-BarringConfig OPTIONAL,
    ac-BarringForMO-Data AC-BarringConfig OPTIONAL
  } OPTIONAL,
  radioResourceConfigCommon RadioResourceConfigCommonSIB,
  ue-TimersAndConstants UE-TimersAndConstants,
  freqInfo SEQUENCE {
    ul-CarrierFreq ARFCN-ValueEUTRA OPTIONAL,
    ul-Bandwidth ENUMERATED {n6, n15, n25, n50, n75, n100} OPTIONAL,
    additionalSpectrumEmission AdditionalSpectrumEmission
  },
  mbsfn-SubframeConfigList MBSFN-SubframeConfigList OPTIONAL,
  timeAlignmentTimerCommon TimeAlignmentTimer,
  ...,
  lateNonCriticalExtension OCTET STRING (CONTAINING SystemInformationBlockType2-v8h0-IEs) OPTIONAL,
  [[ ssac-BarringForMMTEL-Voice-r9 AC-BarringConfig OPTIONAL,
     ssac-BarringForMMTEL-Video-r9 AC-BarringConfig OPTIONAL ]],
  [[ ac-BarringForCSFB-r10 AC-BarringConfig OPTIONAL ]],
  [[ ac-BarringSkipForMMTELVoice-r12 ENUMERATED {true} OPTIONAL,
     ac-BarringSkipForMMTELVideo-r12 ENUMERATED {true} OPTIONAL,
     ac-BarringSkipForSMS-r12 ENUMERATED {true} OPTIONAL,
     ac-BarringPerPLMN-List-r12 AC-BarringPerPLMN-List-r12 OPTIONAL ]],
  [[ voiceServiceCauseIndication-r12 ENUMERATED {true} OPTIONAL ]],
  [[ acdc-BarringForCommon-r13 ACDC-BarringForCommon-r13 OPTIONAL,
     acdc-BarringPerPLMN-List-r13 ACDC-BarringPerPLMN-List-r13 OPTIONAL ]],
  [[ udt-RestrictingForCommon-r13 UDT-Restricting-r13 OPTIONAL,
     udt-RestrictingPerPLMN-List-r13 UDT-RestrictingPerPLMN-List-r13 OPTIONAL,
     cIoT-EPS-OptimisationInfo-r13 CIOT-EPS-OptimisationInfo-r13 OPTIONAL,
     useFullResumeID-r13 ENUMERATED {true} OPTIONAL ]],
  [[ unicastFreqHoppingInd-r13 ENUMERATED {true} OPTIONAL ]],
  [[ mbsfn-SubframeConfigList-v1430 MBSFN-SubframeConfigList-v1430 OPTIONAL,
     videoServiceCauseIndication-r14 ENUMERATED {true} OPTIONAL ]],
  [[ plmn-InfoList-r15 PLMN-InfoList-r15 OPTIONAL ]],
  [[ cp-EDT-r15 ENUMERATED {true} OPTIONAL,
     up-EDT-r15 ENUMERATED {true} OPTIONAL,
     idleModeMeasurements-r15 ENUMERATED {true} OPTIONAL,
     reducedCP-LatencyEnabled-r15 ENUMERATED {true} OPTIONAL ]]
}
SystemInformationBlockType2-v8h0-IEs ::= SEQUENCE {
  multiBandInfoList SEQUENCE (SIZE (1..maxMultiBands)) OF AdditionalSpectrumEmission OPTIONAL,
  nonCriticalExtension SystemInformationBlockType2-v9e0-IEs OPTIONAL
}
SystemInformationBlockType2-v9e0-IEs ::= SEQUENCE {
  ul-CarrierFreq-v9e0 ARFCN-ValueEUTRA-v9e0 OPTIONAL,
  nonCriticalExtension SystemInformationBlockType2-v9i0-IEs OPTIONAL
}
SystemInformationBlockType2-v9i0-IEs ::= SEQUENCE {
  nonCriticalExtension SystemInformationBlockType2-v10m0-IEs OPTIONAL,
  dummy SEQUENCE {} OPTIONAL
}
SystemInformationBlockType2-v10m0-IEs ::= SEQUENCE {
  freqInfo-v10l0 SEQUENCE { additionalSpectrumEmission-v10l0 AdditionalSpectrumEmission-v10l0 } OPTIONAL,
  multiBandInfoList-v10l0 SEQUENCE (SIZE (1..maxMultiBands)) OF AdditionalSpectrumEmission-v10l0 OPTIONAL,
  nonCriticalExtension SEQUENCE {} OPTIONAL
}
AC-BarringConfig ::= SEQUENCE {
  ac-BarringFactor ENUMERATED {p00, p05, p10, p15, p20, p25, p30, p40, p50, p60, p70, p75, p80, p85, p90, p95},
  ac-BarringTime ENUMERATED {s4, s8, s16, s32, s64, s128, s256, s512},
  ac-BarringForSpecialAC BIT STRING (SIZE (5))
}
AC-BarringPerPLMN-List-r12 ::= SEQUENCE (SIZE (1..maxPLMN-r11)) OF AC-BarringPerPLMN-r12
AC-BarringPerPLMN-r12 ::= SEQUENCE {
  plmn-IdentityIndex-r12 INTEGER (1..maxPLMN-r11),
  ac-BarringInfo-r12 SEQUENCE {
    ac-BarringForEmergency-r12 BOOLEAN,
    ac-BarringForMO-Signalling-r12 AC-BarringConfig OPTIONAL,
    ac-BarringForMO-Data-r12 AC-BarringConfig OPTIONAL
  } OPTIONAL,
  ac-BarringSkipForMMTELVoice-r12 ENUMERATED {true} OPTIONAL,
  ac-BarringSkipForMMTELVideo-r12 ENUMERATED {true} OPTIONAL,
  ac-BarringSkipForSMS-r12 ENUMERATED {true} OPTIONAL,
  ac-BarringForCSFB-r12 AC-BarringConfig OPTIONAL,
  ssac-BarringForMMTEL-Voice-r12 AC-BarringConfig OPTIONAL,
  ssac-BarringForMMTEL-Video-r12 AC-BarringConfig OPTIONAL
}
PLMN-InfoList-r15 ::= SEQUENCE (SIZE (1..maxPLMN-r11)) OF PLMN-Info-r15
PLMN-Info-r15 ::= SEQUENCE { upperLayerIndication-r15 ENUMERATED {true} OPTIONAL }
MBSFN-SubframeConfigList ::= SEQUENCE (SIZE (1..maxMBSFN-Allocations)) OF MBSFN-SubframeConfig
MBSFN-SubframeConfig ::= SEQUENCE {
  radioframeAllocationPeriod ENUMERATED {n1, n2, n4, n8, n16, n32},
  radioframeAllocationOffset INTEGER (0..7),
  subframeAllocation CHOICE { oneFrame BIT STRING (SIZE (6)), fourFrames BIT STRING (SIZE (24)) }
}
TimeAlignmentTimer ::= ENUMERATED {sf500, sf750, sf1280, sf1920, sf2560, sf5120, sf10240, infinity}
UE-TimersAndConstants ::= SEQUENCE {
  t300 ENUMERATED {ms100, ms200, ms300, ms400, ms600, ms1000, ms1500, ms2000},
  t301 ENUMERATED {ms100, ms200, ms300, ms400, ms600, ms1000, ms1500, ms2000},
  t310 ENUMERATED {ms0, ms50, ms100, ms200, ms500, ms1000, ms2000},
  n310 ENUMERATED {n1, n2, n3, n4, n6, n8, n10, n20},
  t311 ENUMERATED {ms1000, ms3000, ms5000, ms10000, ms15000, ms20000, ms30000},
  n311 ENUMERATED {n1, n2, n3, n4, n5, n6, n8, n10},
  ...,
  [[ t300-v1310 ENUMERATED {ms2500, ms3000, ms3500, ms4000, ms5000, ms6000, ms8000, ms10000} OPTIONAL,
     t301-v1310 ENUMERATED {ms2500, ms3000, ms3500, ms4000, ms5000, ms6000, ms8000, ms10000} OPTIONAL ]],
  [[ t310-v1330 ENUMERATED {ms4000, ms6000} OPTIONAL ]],
  [[ t300-r15 ENUMERATED {ms4000, ms6000, ms8000, ms10000, ms15000, ms25000, ms40000, ms60000} OPTIONAL ]]
}
RadioResourceConfigCommonSIB ::= SEQUENCE {
  rach-ConfigCommon RACH-ConfigCommon,
  bcch-Config BCCH-Config,
  pcch-Config PCCH-Config,
  prach-Config PRACH-ConfigSIB,
  pdsch-ConfigCommon PDSCH-ConfigCommon,
  pusch-ConfigCommon PUSCH-ConfigCommon,
  pucch-ConfigCommon PUCCH-ConfigCommon,
  soundingRS-UL-ConfigCommon SoundingRS-UL-ConfigCommon,
  uplinkPowerControlCommon UplinkPowerControlCommon,
  ul-CyclicPrefixLength UL-CyclicPrefixLength,
  ...,
  [[ uplinkPowerControlCommon-v1020 UplinkPowerControlCommon-v1020 OPTIONAL ]],
  [[ rach-ConfigCommon-v1250 RACH-ConfigCommon-v1250 OPTIONAL ]],
  [[ pusch-ConfigCommon-v1270 PUSCH-ConfigCommon-v1270 OPTIONAL ]],
  [[ bcch-Config-v1310 BCCH-Config-v1310 OPTIONAL,
     pcch-Config-v1310 PCCH-Config-v1310 OPTIONAL,
     freqHoppingParameters-r13 FreqHoppingParameters-r13 OPTIONAL,
     pdsch-ConfigCommon-v1310 PDSCH-ConfigCommon-v1310 OPTIONAL,
     pusch-ConfigCommon-v1310 PUSCH-ConfigCommon-v1310 OPTIONAL,
     prach-ConfigCommon-v1310 PRACH-ConfigSIB-v1310 OPTIONAL,
     pucch-ConfigCommon-v1310 PUCCH-ConfigCommon-v1310 OPTIONAL ]],
  [[ highSpeedConfig-r14 HighSpeedConfig-r14 OPTIONAL,
     prach-Config-v1430 PRACH-Config-v1430 OPTIONAL,
     pucch-ConfigCommon-v1430 PUCCH-ConfigCommon-v1430 OPTIONAL ]]
}
RACH-ConfigCommon ::= SEQUENCE {
  preambleInfo SEQUENCE {
    numberOfRA-Preambles ENUMERATED {n4, n8, n12, n16, n20, n24, n28, n32, n36, n40, n44, n48, n52, n56, n60, n64},
    preamblesGroupAConfig SEQUENCE {
      sizeOfRA-PreamblesGroupA ENUMERATED {n4, n8, n12, n16, n20, n24, n28, n32, n36, n40, n44, n48, n52, n56, n60},
      messageSizeGroupA ENUMERATED {b56, b144, b208, b256},
      messagePowerOffsetGroupB ENUMERATED {minusinfinity, dB0, dB5, dB8, dB10, dB12, dB15, dB18},
      ...
    } OPTIONAL
  },
  powerRampingParameters PowerRampingParameters,
  ra-SupervisionInfo SEQUENCE {
    preambleTransMax PreambleTransMax,
    ra-ResponseWindowSize ENUMERATED {sf2, sf3, sf4, sf5, sf6, sf7, sf8, sf10},
    mac-ContentionResolutionTimer ENUMERATED {sf8, sf16, sf24, sf32, sf40, sf48, sf56, sf64}
  },
  maxHARQ-Msg3Tx INTEGER (1..8),
  ...,
  [[ preambleTransMax-CE-r13 PreambleTransMax OPTIONAL,
     rach-CE-LevelInfoList-r13 RACH-CE-LevelInfoList-r13 OPTIONAL ]],
  [[ edt-PRACH-ParametersCE-r15 EDT-PRACH-ParametersCE-r15 OPTIONAL ]]
}
PowerRampingParameters ::= SEQUENCE {
  powerRampingStep ENUMERATED {dB0, dB2, dB4, dB6},
  preambleInitialReceivedTargetPower ENUMERATED {dBm-120, dBm-118, dBm-116, dBm-114, dBm-112, dBm-110, dBm-108, dBm-106,
    dBm-104, dBm-102, dBm-100, dBm-98, dBm-96, dBm-94, dBm-92, dBm-90}
}
PreambleTransMax ::= ENUMERATED {n3, n4, n5, n6, n7, n8, n10, n20, n50, n100, n200}
RACH-ConfigCommon-v1250 ::= SEQUENCE {
  txFailParams-r12 SEQUENCE {
    connEstFailCount-r12 ENUMERATED {n1, n2, n3, n4},
    connEstFailOffsetValidity-r12 ENUMERATED {s30, s60, s120, s240, s300, s420, s600, s900},
    connEstFailOffset-r12 INTEGER (0..15) OPTIONAL
  }
}
BCCH-Config ::= SEQUENCE { modificationPeriodCoeff ENUMERATED {n2, n4, n8, n16} }
BCCH-Config-v1310 ::= SEQUENCE { modificationPeriodCoeff-v1310 ENUMERATED {n64} }
PCCH-Config ::= SEQUENCE {
  defaultPagingCycle ENUMERATED {rf32, rf64, rf128, rf256},
  nB ENUMERATED {fourT, twoT, oneT, halfT, quarterT, oneEighthT, oneSixteenthT, oneThirtySecondT}
}
PCCH-Config-v1310 ::= SEQUENCE {
  paging-narrowBands-r13 INTEGER (1..16),
  mpdcch-NumRepetition-Paging-r13 ENUMERATED {r1, r2, r4, r8, r16, r32, r64, r128, r256},
  nB-v1310 ENUMERATED {one64thT, one128thT, one256thT} OPTIONAL
}
PRACH-ConfigSIB ::= SEQUENCE {
  rootSequenceIndex INTEGER (0..837),
  prach-ConfigInfo PRACH-ConfigInfo
}
PRACH-ConfigInfo ::= SEQUENCE {
  prach-ConfigIndex INTEGER (0..63),
  highSpeedFlag BOOLEAN,
  zeroCorrelationZoneConfig INTEGER (0..15),
  prach-FreqOffset INTEGER (0..94)
}
PDSCH-ConfigCommon ::= SEQUENCE {
  referenceSignalPower INTEGER (-60..50),
  p-b INTEGER (0..3)
}
PDSCH-ConfigCommon-v1310 ::= SEQUENCE {
  pdsch-maxNumRepetitionCEmodeA-r13 ENUMERATED {r16, r32} OPTIONAL,
  pdsch-maxNumRepetitionCEmodeB-r13 ENUMERATED {r192, r256, r384, r512, r768, r1024, r1536, r2048} OPTIONAL
}
PUSCH-ConfigCommon ::= SEQUENCE {
  pusch-ConfigBasic SEQUENCE {
    n-SB INTEGER (1..4),
    hoppingMode ENUMERATED {interSubFrame, intraAndInterSubFrame},
    pusch-HoppingOffset INTEGER (0..98),
    enable64QAM BOOLEAN
  },
  ul-ReferenceSignalsPUSCH UL-ReferenceSignalsPUSCH
}
PUSCH-ConfigCommon-v1270 ::= SEQUENCE { enable64QAM-v1270 ENUMERATED {true} }
PUSCH-ConfigCommon-v1310 ::= SEQUENCE {
  pusch-maxNumRepetitionCEmodeA-r13 ENUMERATED {r8, r16, r32} OPTIONAL,
  pusch-maxNumRepetitionCEmodeB-r13 ENUMERATED {r192, r256, r384, r512, r768, r1024, r1536, r2048} OPTIONAL,
  pusch-HoppingOffset-v1310 INTEGER (1..16) OPTIONAL
}
UL-ReferenceSignalsPUSCH ::= SEQUENCE {
  groupHoppingEnabled BOOLEAN,
  groupAssignmentPUSCH INTEGER (0..29),
  sequenceHoppingEnabled BOOLEAN,
  cyclicShift INTEGER (0..7)
}
PUCCH-ConfigCommon ::= SEQUENCE {
  deltaPUCCH-Shift ENUMERATED {ds1, ds2, ds3},
  nRB-CQI INTEGER (0..98),
  nCS-AN INTEGER (0..7),
  n1PUCCH-AN INTEGER (0..2047)
}
SoundingRS-UL-ConfigCommon ::= CHOICE {
  release NULL,
  setup SEQUENCE {
    srs-BandwidthConfig ENUMERATED {bw0, bw1, bw2, bw3, bw4, bw5, bw6, bw7},
    srs-SubframeConfig ENUMERATED {sc0, sc1, sc2, sc3, sc4, sc5, sc6, sc7, sc8, sc9, sc10, sc11, sc12, sc13, sc14, sc15},
    ackNackSRS-SimultaneousTransmission BOOLEAN,
    srs-MaxUpPts ENUMERATED {true} OPTIONAL
  }
}
UplinkPowerControlCommon ::= SEQUENCE {
  p0-NominalPUSCH INTEGER (-126..24),
  alpha ENUMERATED {al0, al04, al05, al06, al07, al08, al09, al1},
  p0-NominalPUCCH INTEGER (-127..-96),
  deltaFList-PUCCH DeltaFList-PUCCH,
  deltaPreambleMsg3 INTEGER (-1..6)
}
UplinkPowerControlCommon-v1020 ::= SEQUENCE {
  deltaF-PUCCH-Format3-r10 ENUMERATED {deltaF-1, deltaF0, deltaF1, deltaF2, deltaF3, deltaF4, deltaF5, deltaF6},
  deltaF-PUCCH-Format1bCS-r10 ENUMERATED {deltaF1, deltaF2, spare2, spare1}
}
DeltaFList-PUCCH ::= SEQUENCE {
  deltaF-PUCCH-Format1 ENUMERATED {deltaF-2, deltaF0, deltaF2},
  deltaF-PUCCH-Format1b ENUMERATED {deltaF1, deltaF3, deltaF5},
  deltaF-PUCCH-Format2 ENUMERATED {deltaF-2, deltaF0, deltaF1, deltaF2},
  deltaF-PUCCH-Format2a ENUMERATED {deltaF-2, deltaF0, deltaF2},
  deltaF-PUCCH-Format2b ENUMERATED {deltaF-2, deltaF0, deltaF2}
}
UL-CyclicPrefixLength ::= ENUMERATED {len1, len2}

SystemInformationBlockType3 ::= SEQUENCE {
  cellReselectionInfoCommon SEQUENCE {
    q-Hyst ENUMERATED {dB0, dB1, dB2, dB3, dB4, dB5, dB6, dB8, dB10, dB12, dB14, dB16, dB18, dB20, dB22, dB24},
    speedStateReselectionPars SEQUENCE {
      mobilityStateParameters MobilityStateParameters,
      q-HystSF SEQUENCE {
        sf-Medium ENUMERATED {dB-6, dB-4, dB-2, dB0},
        sf-High ENUMERATED {dB-6, dB-4, dB-2, dB0}
      }
    } OPTIONAL
  },
  cellReselectionServingFreqInfo SEQUENCE {
    s-NonIntraSearch ReselectionThreshold OPTIONAL,
    threshServingLow ReselectionThreshold,
    cellReselectionPriority CellReselectionPriority
  },
  intraFreqCellReselectionInfo SEQUENCE {
    q-RxLevMin Q-RxLevMin,
    p-Max P-Max OPTIONAL,
    s-IntraSearch ReselectionThreshold OPTIONAL,
    allowedMeasBandwidth AllowedMeasBandwidth OPTIONAL,
    presenceAntennaPort1 PresenceAntennaPort1,
    neighCellConfig NeighCellConfig,
    t-ReselectionEUTRA T-Reselection,
    t-ReselectionEUTRA-SF SpeedStateScaleFactors OPTIONAL
  },
  ...,
  lateNonCriticalExtension OCTET STRING OPTIONAL,
  [[ s-IntraSearch-v920 SEQUENCE {
       s-IntraSearchP-r9 ReselectionThreshold,
       s-IntraSearchQ-r9 ReselectionThresholdQ-r9
     } OPTIONAL,
     s-NonIntraSearch-v920 SEQUENCE {
       s-NonIntraSearchP-r9 ReselectionThreshold,
       s-NonIntraSearchQ-r9 ReselectionThresholdQ-r9
     } OPTIONAL,
     q-QualMin-r9 Q-QualMin-r9 OPTIONAL,
     threshServingLowQ-r9 ReselectionThresholdQ-r9 OPTIONAL ]],
  [[ q-QualMinWB-r11 Q-QualMin-r9 OPTIONAL ]],
  [[ q-QualMinRSRQ-OnAllSymbols-r12 Q-QualMin-r9 OPTIONAL ]],
  [[ cellReselectionServingFreqInfo-v1310 CellReselectionServingFreqInfo-v1310 OPTIONAL,
     redistributionServingInfo-r13 RedistributionServingInfo-r13 OPTIONAL,
     cellSelectionInfoCE-r13 CellSelectionInfoCE-r13 OPTIONAL,
     t-ReselectionEUTRA-CE-r13 T-ReselectionEUTRA-CE-r13 OPTIONAL ]],
  [[ cellSelectionInfoCE1-r13 CellSelectionInfoCE1-r13 OPTIONAL ]],
  [[ cellSelectionInfoCE1-v1360 CellSelectionInfoCE1-v1360 OPTIONAL ]],
  [[ cellReselectionInfoCommon-v1460 CellReselectionInfoCommon-v1460 OPTIONAL ]],
  [[ cellReselectionInfoHSDN-r15 CellReselectionInfoHSDN-r15 OPTIONAL,
     cellSelectionInfoCE-v1530 CellSelectionInfoCE-v1530 OPTIONAL,
     crs-IntfMitigNeighCellsCE-r15 ENUMERATED {enabled} OPTIONAL ]]
}
CellReselectionServingFreqInfo-v1310 ::= SEQUENCE { cellReselectionSubPriority-r13 CellReselectionSubPriority-r13 }
CellReselectionInfoCommon-v1460 ::= SEQUENCE { s-SearchDeltaP-r14 ENUMERATED {dB6, dB9, dB12, dB15} }
CellReselectionInfoHSDN-r15 ::= SEQUENCE { cellEquivalentSize-r15 INTEGER (2..16) }
T-ReselectionEUTRA-CE-r13 ::= INTEGER (0..15)
MobilityStateParameters ::= SEQUENCE {
  t-Evaluation ENUMERATED {s30, s60, s120, s180, s240, spare3, spare2, spare1},
  t-HystNormal ENUMERATED {s30, s60, s120, s180, s240, spare3, spare2, spare1},
  n-CellChangeMedium INTEGER (1..16),
  n-CellChangeHigh INTEGER (1..16)
}
ReselectionThreshold ::= INTEGER (0..31)
ReselectionThresholdQ-r9 ::= INTEGER (0..31)
CellReselectionPriority ::= INTEGER (0..7)
CellReselectionSubPriority-r13 ::= ENUMERATED {oDot2, oDot4, oDot6, oDot8}
AllowedMeasBandwidth ::= ENUMERATED {mbw6, mbw15, mbw25, mbw50, mbw75, mbw100}
PresenceAntennaPort1 ::= BOOLEAN
NeighCellConfig ::= BIT STRING (SIZE (2))
T-Reselection ::= INTEGER (0..7)
SpeedStateScaleFactors ::= SEQUENCE {
  sf-Medium ENUMERATED {oDot25, oDot5, oDot75, lDot0},
  sf-High ENUMERATED {oDot25, oDot5, oDot75, lDot0}
}
Q-OffsetRange ::= ENUMERATED {dB-24, dB-22, dB-20, dB-18, dB-16, dB-14, dB-12, dB-10, dB-8, dB-6, dB-5, dB-4, dB-3, dB-2,
  dB-1, dB0, dB1, dB2, dB3, dB4, dB5, dB6, dB8, dB10, dB12, dB14, dB16, dB18, dB20, dB22, dB24}
PhysCellId ::= INTEGER (0..503)
PhysCellIdRange ::= SEQUENCE {
  start PhysCellId,
  range ENUMERATED {n4, n8, n12, n16, n24, n32, n48, n64, n84, n96, n128, n168, n252, n504, spare2, spare1} OPTIONAL
}

SystemInformationBlockType4 ::= SEQUENCE {
  intraFreqNeighCellList IntraFreqNeighCellList OPTIONAL,
  intraFreqExcludedCellList IntraFreqExcludedCellList OPTIONAL,
  csg-PhysCellIdRange PhysCellIdRange OPTIONAL,
  ...,
  lateNonCriticalExtension OCTET STRING OPTIONAL,
  [[ intraFreqNeighCellList-v1610 OCTET STRING OPTIONAL ]]
}
IntraFreqNeighCellList ::= SEQUENCE (SIZE (1..maxCellIntra)) OF IntraFreqNeighCellInfo
IntraFreqNeighCellInfo ::= SEQUENCE {
  physCellId PhysCellId,
  q-OffsetCell Q-OffsetRange,
  ...
}
IntraFreqExcludedCellList ::= SEQUENCE (SIZE (1..maxCellBlack)) OF PhysCellIdRange

SystemInformationBlockType5 ::= SEQUENCE {
  interFreqCarrierFreqList InterFreqCarrierFreqList,
  ...,
  lateNonCriticalExtension OCTET STRING (CONTAINING SystemInformationBlockType5-v8h0-IEs) OPTIONAL,
  [[ interFreqCarrierFreqList-v1250 OCTET STRING OPTIONAL,
     interFreqCarrierFreqListExt-r12 OCTET STRING OPTIONAL ]],
  [[ interFreqCarrierFreqListExt-v1280 OCTET STRING OPTIONAL ]],
  [[ interFreqCarrierFreqList-v1310 OCTET STRING OPTIONAL,
     interFreqCarrierFreqListExt-v1310 OCTET STRING OPTIONAL ]],
  [[ interFreqCarrierFreqList-v1350 OCTET STRING OPTIONAL,
     interFreqCarrierFreqListExt-v1350 OCTET STRING OPTIONAL ]],
  [[ interFreqCarrierFreqListExt-v1360 OCTET STRING OPTIONAL ]],
  [[ scptm-FreqOffset-r14 INTEGER (1..8) OPTIONAL ]],
  [[ interFreqCarrierFreqList-v1530 OCTET STRING OPTIONAL,
     interFreqCarrierFreqListExt-v1530 OCTET STRING OPTIONAL,
     measIdleConfigSIB-r15 OCTET STRING OPTIONAL ]]
}
InterFreqCarrierFreqList ::= SEQUENCE (SIZE (1..maxFreq)) OF InterFreqCarrierFreqInfo
InterFreqCarrierFreqInfo ::= SEQUENCE {
  dl-CarrierFreq ARFCN-ValueEUTRA,
  q-RxLevMin Q-RxLevMin,
  p-Max P-Max OPTIONAL,
  t-ReselectionEUTRA T-Reselection,
  t-ReselectionEUTRA-SF SpeedStateScaleFactors OPTIONAL,
  threshX-High ReselectionThreshold,
  threshX-Low ReselectionThreshold,
  allowedMeasBandwidth AllowedMeasBandwidth,
  presenceAntennaPort1 PresenceAntennaPort1,
  cellReselectionPriority CellReselectionPriority OPTIONAL,
  neighCellConfig NeighCellConfig,
  q-OffsetFreq Q-OffsetRange DEFAULT dB0,
  interFreqNeighCellList InterFreqNeighCellList OPTIONAL,
  interFreqExcludedCellList InterFreqExcludedCellList OPTIONAL,
  ...,
  [[ q-QualMin-r9 Q-QualMin-r9 OPTIONAL,
     threshX-Q-r9 SEQUENCE {
       threshX-HighQ-r9 ReselectionThresholdQ-r9,
       threshX-LowQ-r9 ReselectionThresholdQ-r9
     } OPTIONAL ]],
  [[ q-QualMinWB-r11 Q-QualMin-r9 OPTIONAL ]]
}
InterFreqNeighCellList ::= SEQUENCE (SIZE (1..maxCellInter)) OF InterFreqNeighCellInfo
InterFreqNeighCellInfo ::= SEQUENCE {
  physCellId PhysCellId,
  q-OffsetCell Q-OffsetRange
}
InterFreqExcludedCellList ::= SEQUENCE (SIZE (1..maxCellBlack)) OF PhysCellIdRange
SystemInformationBlockType5-v8h0-IEs ::= SEQUENCE {
  interFreqCarrierFreqList-v8h0 SEQUENCE (SIZE (1..maxFreq)) OF InterFreqCarrierFreqInfo-v8h0 OPTIONAL,
  nonCriticalExtension SystemInformationBlockType5-v9e0-IEs OPTIONAL
}
InterFreqCarrierFreqInfo-v8h0 ::= SEQUENCE { multiBandInfoList MultiBandInfoList OPTIONAL }
SystemInformationBlockType5-v9e0-IEs ::= SEQUENCE {
  interFreqCarrierFreqList-v9e0 SEQUENCE (SIZE (1..maxFreq)) OF InterFreqCarrierFreqInfo-v9e0 OPTIONAL,
  nonCriticalExtension SystemInformationBlockType5-v10j0-IEs OPTIONAL
}
InterFreqCarrierFreqInfo-v9e0 ::= SEQUENCE {
  dl-CarrierFreq-v9e0 ARFCN-ValueEUTRA-v9e0 OPTIONAL,
  multiBandInfoList-v9e0 MultiBandInfoList-v9e0 OPTIONAL
}
SystemInformationBlockType5-v10j0-IEs ::= SEQUENCE {
  interFreqCarrierFreqList-v10j0 SEQUENCE (SIZE (1..maxFreq)) OF InterFreqCarrierFreqInfo-v10j0 OPTIONAL,
  nonCriticalExtension SystemInformationBlockType5-v10l0-IEs OPTIONAL
}
InterFreqCarrierFreqInfo-v10j0 ::= SEQUENCE {
  freqBandInfo-r10 NS-PmaxList-r10 OPTIONAL,
  multiBandInfoList-v10j0 MultiBandInfoList-v10j0 OPTIONAL
}
SystemInformationBlockType5-v10l0-IEs ::= SEQUENCE {
  interFreqCarrierFreqList-v10l0 SEQUENCE (SIZE (1..maxFreq)) OF InterFreqCarrierFreqInfo-v10l0 OPTIONAL,
  nonCriticalExtension SEQUENCE {} OPTIONAL
}
InterFreqCarrierFreqInfo-v10l0 ::= SEQUENCE {
  freqBandInfo-v10l0 NS-PmaxList-v10l0 OPTIONAL,
  multiBandInfoList-v10l0 MultiBandInfoList-v10l0 OPTIONAL
}

SystemInformationBlockType6 ::= SEQUENCE {
  carrierFreqListUTRA-FDD CarrierFreqListUTRA-FDD OPTIONAL,
  carrierFreqListUTRA-TDD CarrierFreqListUTRA-TDD OPTIONAL,
  t-ReselectionUTRA T-Reselection,
  t-ReselectionUTRA-SF SpeedStateScaleFactors OPTIONAL,
  ...,
  lateNonCriticalExtension OCTET STRING OPTIONAL,
  [[ carrierFreqListUTRA-FDD-v1250 OCTET STRING OPTIONAL,
     carrierFreqListUTRA-TDD-v1250 OCTET STRING OPTIONAL,
     carrierFreqListUTRA-FDD-Ext-r12 OCTET STRING OPTIONAL,
     carrierFreqListUTRA-TDD-Ext-r12 OCTET STRING OPTIONAL ]]
}
CarrierFreqListUTRA-FDD ::= SEQUENCE (SIZE (1..maxUTRA-FDD-Carrier)) OF CarrierFreqUTRA-FDD
CarrierFreqUTRA-FDD ::= SEQUENCE {
  carrierFreq ARFCN-ValueUTRA,
  cellReselectionPriority CellReselectionPriority OPTIONAL,
  threshX-High ReselectionThreshold,
  threshX-Low ReselectionThreshold,
  q-RxLevMin INTEGER (-60..-13),
  p-MaxUTRA INTEGER (-50..33),
  q-QualMin INTEGER (-24..0),
  ...,
  [[ threshX-Q-r9 SEQUENCE {
       threshX-HighQ-r9 ReselectionThresholdQ-r9,
       threshX-LowQ-r9 ReselectionThresholdQ-r9
     } OPTIONAL ]]
}
CarrierFreqListUTRA-TDD ::= SEQUENCE (SIZE (1..maxUTRA-TDD-Carrier)) OF CarrierFreqUTRA-TDD
CarrierFreqUTRA-TDD ::= SEQUENCE {
  carrierFreq ARFCN-ValueUTRA,
  cellReselectionPriority CellReselectionPriority OPTIONAL,
  threshX-High ReselectionThreshold,
  threshX-Low ReselectionThreshold,
  q-RxLevMin INTEGER (-60..-13),
  p-MaxUTRA INTEGER (-50..33),
  ...
}
ARFCN-ValueUTRA ::= INTEGER (0..16383)

SystemInformationBlockType7 ::= SEQUENCE {
  t-ReselectionGERAN T-Reselection,
  t-ReselectionGERAN-SF SpeedStateScaleFactors OPTIONAL,
  carrierFreqsInfoList CarrierFreqsInfoListGERAN OPTIONAL,
  ...,
  lateNonCriticalExtension OCTET STRING OPTIONAL
}
CarrierFreqsInfoListGERAN ::= SEQUENCE (SIZE (1..maxGNFG)) OF CarrierFreqsInfoGERAN
CarrierFreqsInfoGERAN ::= SEQUENCE {
  carrierFreqs CarrierFreqsGERAN,
  commonInfo SEQUENCE {
    cellReselectionPriority CellReselectionPriority OPTIONAL,
    ncc-Permitted BIT STRING (SIZE (8)),
    q-RxLevMin INTEGER (0..45),
    p-MaxGERAN INTEGER (0..39) OPTIONAL,
    threshX-High ReselectionThreshold,
    threshX-Low ReselectionThreshold
  },
  ...
}
CarrierFreqsGERAN ::= SEQUENCE {
  startingARFCN ARFCN-ValueGERAN,
  bandIndicator ENUMERATED {dcs1800, pcs1900},
  followingARFCNs CHOICE {
    explicitListOfARFCNs SEQUENCE (SIZE (0..31)) OF ARFCN-ValueGERAN,
    equallySpacedARFCNs SEQUENCE {
      arfcn-Spacing INTEGER (1..8),
      numberOfFollowingARFCNs INTEGER (0..31)
    },
    variableBitMapOfARFCNs OCTET STRING (SIZE (1..16))
  }
}
ARFCN-ValueGERAN ::= INTEGER (0..1023)

SystemInformationBlockType8 ::= SEQUENCE {
  systemTimeInfo SystemTimeInfoCDMA2000 OPTIONAL,
  searchWindowSize INTEGER (0..15) OPTIONAL,
  parametersHRPD SEQUENCE {
    preRegistrationInfoHRPD PreRegistrationInfoHRPD,
    cellReselectionParametersHRPD CellReselectionParametersCDMA2000 OPTIONAL
  } OPTIONAL,
  parameters1XRTT SEQUENCE {
    csfb-RegistrationParam1XRTT CSFB-RegistrationParam1XRTT OPTIONAL,
    longCodeState1XRTT BIT STRING (SIZE (42)) OPTIONAL,
    cellReselectionParameters1XRTT CellReselectionParametersCDMA2000 OPTIONAL
  } OPTIONAL,
  ...,
  lateNonCriticalExtension OCTET STRING OPTIONAL,
  [[ csfb-SupportForDualRxUEs-r9 BOOLEAN OPTIONAL,
     cellReselectionParametersHRPD-v920 CellReselectionParametersCDMA2000-v920 OPTIONAL,
     cellReselectionParameters1XRTT-v920 CellReselectionParametersCDMA2000-v920 OPTIONAL,
     csfb-RegistrationParam1XRTT-v920 CSFB-RegistrationParam1XRTT-v920 OPTIONAL,
     ac-BarringConfig1XRTT-r9 AC-BarringConfig1XRTT-r9 OPTIONAL ]],
  [[ csfb-DualRxTxSupport-r10 ENUMERATED {true} OPTIONAL ]],
  [[ sib8-PerPLMN-List-r11 OCTET STRING OPTIONAL ]]
}
SystemTimeInfoCDMA2000 ::= SEQUENCE {
  cdma-EUTRA-Synchronisation BOOLEAN,
  cdma-SystemTime CHOICE {
    synchronousSystemTime BIT STRING (SIZE (39)),
    asynchronousSystemTime BIT STRING (SIZE (49))
  }
}
PreRegistrationInfoHRPD ::= SEQUENCE {
  preRegistrationAllowed BOOLEAN,
  preRegistrationZoneId INTEGER (0..255) OPTIONAL,
  secondaryPreRegistrationZoneIdList SEQUENCE (SIZE (1..2)) OF INTEGER (0..255) OPTIONAL
}
CellReselectionParametersCDMA2000 ::= SEQUENCE {
  bandClassList BandClassListCDMA2000,
  neighCellList NeighCellListCDMA2000,
  t-ReselectionCDMA2000 T-Reselection,
  t-ReselectionCDMA2000-SF SpeedStateScaleFactors OPTIONAL
}
CellReselectionParametersCDMA2000-v920 ::= SEQUENCE {
  neighCellList-v920 SEQUENCE (SIZE (1..16)) OF NeighCellCDMA2000-v920
}
NeighCellCDMA2000-v920 ::= SEQUENCE {
  neighCellsPerFreqList-v920 SEQUENCE (SIZE (1..16)) OF NeighCellsPerBandclassCDMA2000-v920
}
NeighCellsPerBandclassCDMA2000-v920 ::= SEQUENCE {
  physCellIdList-v920 SEQUENCE (SIZE (0..24)) OF PhysCellIdCDMA2000
}
BandClassListCDMA2000 ::= SEQUENCE (SIZE (1..maxCDMA-BandClass)) OF BandClassInfoCDMA2000
BandClassInfoCDMA2000 ::= SEQUENCE {
  bandClass BandclassCDMA2000,
  cellReselectionPriority CellReselectionPriority OPTIONAL,
  threshX-High INTEGER (0..63),
  threshX-Low INTEGER (0..63),
  ...
}
BandclassCDMA2000 ::= ENUMERATED {bc0, bc1, bc2, bc3, bc4, bc5, bc6, bc7, bc8, bc9, bc10, bc11, bc12, bc13, bc14, bc15, bc16,
  bc17, bc18-v9a0, bc19-v9a0, bc20-v9a0, bc21-v9a0, spare10, spare9, spare8, spare7, spare6, spare5, spare4, spare3,
  spare2, spare1, ...}
NeighCellListCDMA2000 ::= SEQUENCE (SIZE (1..16)) OF NeighCellCDMA2000
NeighCellCDMA2000 ::= SEQUENCE {
  bandClass BandclassCDMA2000,
  neighCellsPerFreqList SEQUENCE (SIZE (1..16)) OF NeighCellsPerBandclassCDMA2000
}
NeighCellsPerBandclassCDMA2000 ::= SEQUENCE {
  arfcn INTEGER (0..2047),
  physCellIdList SEQUENCE (SIZE (1..16)) OF PhysCellIdCDMA2000
}
PhysCellIdCDMA2000 ::= INTEGER (0..maxPNOffset)
CSFB-RegistrationParam1XRTT ::= SEQUENCE {
  sid BIT STRING (SIZE (15)),
  nid BIT STRING (SIZE (16)),
  multipleSID BOOLEAN,
  multipleNID BOOLEAN,
  homeReg BOOLEAN,
  foreignSIDReg BOOLEAN,
  foreignNIDReg BOOLEAN,
  parameterReg BOOLEAN,
  powerUpReg BOOLEAN,
  registrationPeriod BIT STRING (SIZE (7)),
  registrationZone BIT STRING (SIZE (12)),
  totalZone BIT STRING (SIZE (3)),
  zoneTimer BIT STRING (SIZE (3))
}
CSFB-RegistrationParam1XRTT-v920 ::= SEQUENCE { powerDownReg-r9 ENUMERATED {true} }
AC-BarringConfig1XRTT-r9 ::= SEQUENCE {
  ac-Barring0to9-r9 INTEGER (0..63),
  ac-Barring10-r9 INTEGER (0..7),
  ac-Barring11-r9 INTEGER (0..7),
  ac-Barring12-r9 INTEGER (0..7),
  ac-Barring13-r9 INTEGER (0..7),
  ac-Barring14-r9 INTEGER (0..7),
  ac-Barring15-r9 INTEGER (0..7),
  ac-BarringMsg-r9 INTEGER (0..7),
  ac-BarringReg-r9 INTEGER (0..7),
  ac-BarringEmg-r9 INTEGER (0..7)
}

SystemInformationBlockType9 ::= SEQUENCE {
  hnb-Name OCTET STRING (SIZE (1..48)) OPTIONAL,
  ...,
  lateNonCriticalExtension OCTET STRING OPTIONAL
}
SystemInformationBlockType10 ::= SEQUENCE {
  messageIdentifier BIT STRING (SIZE (16)),
  serialNumber BIT STRING (SIZE (16)),
  warningType OCTET STRING (SIZE (2)),
  dummy OCTET STRING (SIZE (50)) OPTIONAL,
  ...,
  lateNonCriticalExtension OCTET STRING OPTIONAL
}
SystemInformationBlockType11 ::= SEQUENCE {
  messageIdentifier BIT STRING (SIZE (16)),
  serialNumber BIT STRING (SIZE (16)),
  warningMessageSegmentType ENUMERATED {notLastSegment, lastSegment},
  warningMessageSegmentNumber INTEGER (0..63),
  warningMessageSegment OCTET STRING,
  dataCodingScheme OCTET STRING (SIZE (1)) OPTIONAL,
  ...,
  lateNonCriticalExtension OCTET STRING OPTIONAL
}
SystemInformationBlockType12-r9 ::= SEQUENCE {
  messageIdentifier-r9 BIT STRING (SIZE (16)),
  serialNumber-r9 BIT STRING (SIZE (16)),
  warningMessageSegmentType-r9 ENUMERATED {notLastSegment, lastSegment},
  warningMessageSegmentNumber-r9 INTEGER (0..63),
  warningMessageSegment-r9 OCTET STRING,
  dataCodingScheme-r9 OCTET STRING (SIZE (1)) OPTIONAL,
  lateNonCriticalExtension OCTET STRING OPTIONAL,
  ...,
  [[ warningAreaCoordinatesSegment-r15 OCTET STRING OPTIONAL ]]
}
SystemInformationBlockType13-r9 ::= SEQUENCE {
  mbsfn-AreaInfoList-r9 SEQUENCE (SIZE (1..maxMBSFN-Area)) OF MBSFN-AreaInfo-r9,
  notificationConfig-r9 MBMS-NotificationConfig-r9,
  lateNonCriticalExtension OCTET STRING OPTIONAL,
  ...
}
MBSFN-AreaInfo-r9 ::= SEQUENCE {
  mbsfn-AreaId-r9 INTEGER (0..255),
  non-MBSFNregionLength ENUMERATED {s1, s2},
  notificationIndicator-r9 INTEGER (0..7),
  mcch-Config-r9 SEQUENCE {
    mcch-RepetitionPeriod-r9 ENUMERATED {rf32, rf64, rf128, rf256},
    mcch-Offset-r9 INTEGER (0..10),
    mcch-ModificationPeriod-r9 ENUMERATED {rf512, rf1024},
    sf-AllocInfo-r9 BIT STRING (SIZE (6)),
    signallingMCS-r9 ENUMERATED {n2, n7, n13, n19}
  },
  ...
}
MBMS-NotificationConfig-r9 ::= SEQUENCE {
  notificationRepetitionCoeff-r9 ENUMERATED {n2, n4},
  notificationOffset-r9 INTEGER (0..10),
  notificationSF-Index-r9 INTEGER (1..6)
}
SystemInformationBlockType16-r11 ::= SEQUENCE {
  timeInfo-r11 SEQUENCE {
    timeInfoUTC-r11 INTEGER (0..549755813887),
    dayLightSavingTime-r11 BIT STRING (SIZE (2)) OPTIONAL,
    leapSeconds-r11 INTEGER (-127..128) OPTIONAL,
    localTimeOffset-r11 INTEGER (-63..64) OPTIONAL
  } OPTIONAL,
  lateNonCriticalExtension OCTET STRING OPTIONAL,
  ...
}

SystemInformationBlockType24-r15 ::= SEQUENCE {
  carrierFreqListNR-r15 CarrierFreqListNR-r15 OPTIONAL,
  t-ReselectionNR-r15 T-Reselection,
  t-ReselectionNR-SF-r15 SpeedStateScaleFactors OPTIONAL,
  lateNonCriticalExtension OCTET STRING OPTIONAL,
  ...,
  [[ carrierFreqListNR-v1610 OCTET STRING OPTIONAL ]]
}
CarrierFreqListNR-r15 ::= SEQUENCE (SIZE (1..maxFreqNR-r15)) OF CarrierFreqNR-r15
CarrierFreqNR-r15 ::= SEQUENCE {
  carrierFreq-r15 ARFCN-ValueNR-r15,
  multiBandInfoList-r15 MultiFrequencyBandListNR-r15 OPTIONAL,
  multiBandInfoListSUL-r15 MultiFrequencyBandListNR-r15 OPTIONAL,
  measTimingConfig-r15 MTC-SSB-NR-r15 OPTIONAL,
  subcarrierSpacingSSB-r15 ENUMERATED {kHz15, kHz30, kHz120, kHz240},
  ssb-ToMeasure-r15 SSB-ToMeasure-r15 OPTIONAL,
  cellReselectionPriority-r15 CellReselectionPriority OPTIONAL,
  cellReselectionSubPriority-r15 CellReselectionSubPriority-r13 OPTIONAL,
  threshX-High-r15 ReselectionThreshold,
  threshX-Low-r15 ReselectionThreshold,
  threshX-Q-r15 SEQUENCE {
    threshX-HighQ-r15 ReselectionThresholdQ-r9,
    threshX-LowQ-r15 ReselectionThresholdQ-r9
  } OPTIONAL,
  q-RxLevMin-r15 INTEGER (-70..-22),
  q-RxLevMinSUL-r15 INTEGER (-70..-22) OPTIONAL,
  p-MaxNR-r15 P-MaxNR-r15,
  ns-PmaxListNR-r15 NS-PmaxListNR-r15 OPTIONAL,
  q-QualMin-r15 INTEGER (-43..-12) OPTIONAL,
  deriveSSB-IndexFromCell-r15 BOOLEAN,
  maxRS-IndexCellQual-r15 MaxRS-IndexCellQual-r15 OPTIONAL,
  threshRS-Index-r15 ThresholdListNR-r15 OPTIONAL,
  ...
}
ARFCN-ValueNR-r15 ::= INTEGER (0..3279165)
MultiFrequencyBandListNR-r15 ::= SEQUENCE (SIZE (1..maxMultiBandsNR-r15)) OF FreqBandIndicatorNR-r15
FreqBandIndicatorNR-r15 ::= INTEGER (1..1024)
P-MaxNR-r15 ::= INTEGER (-30..33)
MTC-SSB-NR-r15 ::= SEQUENCE {
  periodicityAndOffset-r15 CHOICE {
    sf5-r15 INTEGER (0..4),
    sf10-r15 INTEGER (0..9),
    sf20-r15 INTEGER (0..19),
    sf40-r15 INTEGER (0..39),
    sf80-r15 INTEGER (0..79),
    sf160-r15 INTEGER (0..159)
  },
  ssb-Duration-r15 ENUMERATED {sf1, sf2, sf3, sf4, sf5}
}
SSB-ToMeasure-r15 ::= CHOICE {
  shortBitmap-r15 BIT STRING (SIZE (4)),
  mediumBitmap-r15 BIT STRING (SIZE (8)),
  longBitmap-r15 BIT STRING (SIZE (64))
}
NS-PmaxListNR-r15 ::= SEQUENCE (SIZE (1..maxNS-Pmax-r10)) OF NS-PmaxValueNR-r15
NS-PmaxValueNR-r15 ::= SEQUENCE {
  additionalPmaxNR-r15 P-MaxNR-r15 OPTIONAL,
  additionalSpectrumEmissionNR-r15 INTEGER (0..7)
}
MaxRS-IndexCellQual-r15 ::= INTEGER (1..maxRS-Index-r15)
ThresholdListNR-r15 ::= SEQUENCE {
  nr-RSRP-r15 INTEGER (0..127) OPTIONAL,
  nr-RSRQ-r15 INTEGER (0..127) OPTIONAL,
  nr-SINR-r15 INTEGER (0..127) OPTIONAL
}
`;
