package com.michael.tms.plugins

import com.michael.tms.routes.adminRoutes
import com.michael.tms.routes.authRoutes
import com.michael.tms.routes.siteRoutes
import com.michael.tms.routes.testResultRoutes
import com.michael.tms.routes.testSessionRoutes
import com.michael.tms.routes.transformerRoutes
import com.michael.tms.routes.userRoutes
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.Application
import io.ktor.server.application.call
import io.ktor.server.auth.authenticate
import io.ktor.server.response.respond
import io.ktor.server.routing.get
import io.ktor.server.routing.route
import io.ktor.server.routing.routing

fun Application.configureRouting() {
    routing {
        get("/health") { call.respond(HttpStatusCode.OK, mapOf("status" to "ok")) }

        adminRoutes()

        route("/api/v1") {
            authRoutes()

            authenticate("auth-jwt") {
                userRoutes()
                siteRoutes()
                transformerRoutes()
                testSessionRoutes()
                testResultRoutes()
            }
        }
    }
}
