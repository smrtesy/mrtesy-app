package com.smrtesy.app

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlin.random.Random

class SmrtesyMessagingService : FirebaseMessagingService() {

    override fun onNewToken(token: String) {
        // שלח את הטוקן לשרת smrtesy
        // כאן אפשר לקרוא ל-API של smrtesy עם הטוקן
        // לדוגמה: sendTokenToServer(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val title = message.notification?.title ?: message.data["title"] ?: return
        val body = message.notification?.body ?: message.data["body"] ?: return
        val navigateUrl = message.data["navigate_url"]
        val channel = message.data["channel"] ?: "smrtesy_main"

        showNotification(title, body, navigateUrl, channel)
    }

    private fun showNotification(
        title: String,
        body: String,
        navigateUrl: String?,
        channel: String
    ) {
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            navigateUrl?.let { putExtra("navigate_url", it) }
        }

        val pendingIntent = PendingIntent.getActivity(
            this,
            Random.nextInt(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(this, channel)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(getColor(R.color.primary))
            .setAutoCancel(true)
            .setContentIntent(pendingIntent)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()

        getSystemService(NotificationManager::class.java)
            .notify(Random.nextInt(), notification)
    }
}
