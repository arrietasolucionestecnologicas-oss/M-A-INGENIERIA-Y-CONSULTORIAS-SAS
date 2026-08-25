package com.michael.tms.plugins

import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.Application
import io.ktor.server.application.install
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import com.michael.tms.model.JsonSupport

fun Application.configureSerialization() {
    install(ContentNegotiation) {
        json(JsonSupport.json)
    }
}
