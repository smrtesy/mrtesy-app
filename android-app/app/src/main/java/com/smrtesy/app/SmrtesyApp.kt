package com.smrtesy.app

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build

class SmrtesyApp : Application() {

    override fun onCreate() {
        super.onCreate()
        createNotificationChannels()
    }

    private fun createNotificationChannels() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)

            manager.createNotificationChannel(
                NotificationChannel(
                    "smrtesy_main",
                    getString(R.string.channel_main_name),
                    NotificationManager.IMPORTANCE_HIGH
                ).apply {
                    description = getString(R.string.channel_main_desc)
                    enableVibration(true)
                }
            )

            manager.createNotificationChannel(
                NotificationChannel(
                    "smrtesy_tasks",
                    getString(R.string.channel_tasks_name),
                    NotificationManager.IMPORTANCE_DEFAULT
                ).apply {
                    description = getString(R.string.channel_tasks_desc)
                }
            )
        }
    }
}
