package com.michael.tms

import com.michael.tms.db.DatabaseFactory
import com.michael.tms.plugins.configureRouting
import com.michael.tms.plugins.configureSecurity
import com.michael.tms.plugins.configureSerialization
import com.michael.tms.plugins.configureStatusPages
import com.michael.tms.plugins.configureTenantKillSwitch
import io.ktor.server.application.Application
import io.ktor.server.netty.EngineMain

fun main(args: Array<String>) {
    EngineMain.main(args)
}

fun Application.module() {
    DatabaseFactory.init(environment.config)
    configureSerialization()
    configureStatusPages()
    configureSecurity()
    configureTenantKillSwitch()
    configureRouting()
}
