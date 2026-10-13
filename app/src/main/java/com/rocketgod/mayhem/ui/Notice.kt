package com.rocketgod.mayhem.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow

/** A short explanation along the bottom of the screen: why a dimmed control does nothing on this radio. */
object Notice {
    val msg = MutableStateFlow<String?>(null)
    fun show(s: String) { msg.value = s }
}

@Composable
fun NoticeBar(modifier: Modifier) {
    val d = rememberDims()
    val m = Notice.msg.collectAsState().value ?: return
    LaunchedEffect(m) { delay(6000); if (Notice.msg.value == m) Notice.msg.value = null }
    Text(m, color = Palette.ink, fontFamily = Mono, fontWeight = FontWeight.Bold, fontSize = d.sp(11f),
        modifier = modifier.fillMaxWidth().padding(d.dp(10f)).background(Palette.surface, RoundedCornerShape(8.dp)).panel(Palette.accent2)
            .clickable { Notice.msg.value = null }.padding(d.dp(12f)))
}

/** A control the attached radio cannot do: dimmed, and a tap says why and what would. */
fun gated(why: String, action: () -> Unit): () -> Unit =
    if (why.isEmpty()) action else { { Notice.show("$why. ${com.rocketgod.mayhem.core.Radio.HACKRF_PITCH}") } }
