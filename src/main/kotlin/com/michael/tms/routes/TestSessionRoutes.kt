package com.michael.tms.routes

import com.michael.tms.model.CreateTestSessionRequest
import com.michael.tms.model.SessionStatus
import com.michael.tms.model.UpdateTestSessionRequest
import com.michael.tms.security.tmsPrincipal
import com.michael.tms.service.TestResultService
import com.michael.tms.service.TestSessionService
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.call
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import io.ktor.server.routing.patch
import io.ktor.server.routing.post
import io.ktor.server.routing.route
import java.util.UUID

fun Route.testSessionRoutes() {
    route("/transformers/{id}/test-sessions") {
        post {
            val principal = call.tmsPrincipal()
            val transformerId = UUID.fromString(call.parameters["id"])
            val request = call.receive<CreateTestSessionRequest>()
            call.respond(
                HttpStatusCode.Created,
                TestSessionService.create(principal.tenantId, transformerId, request, principal.userId)
            )
        }
    }

    route("/test-sessions") {
        get {
            val principal = call.tmsPrincipal()
            val transformerId = call.request.queryParameters["transformerId"]?.let { UUID.fromString(it) }
            val status = call.request.queryParameters["status"]?.let { SessionStatus.valueOf(it) }
            call.respond(TestSessionService.list(principal.tenantId, transformerId, status))
        }
        get("/{id}") {
            val principal = call.tmsPrincipal()
            val id = UUID.fromString(call.parameters["id"])
            call.respond(TestSessionService.get(principal.tenantId, id))
        }
        patch("/{id}") {
            val principal = call.tmsPrincipal()
            val id = UUID.fromString(call.parameters["id"])
            val request = call.receive<UpdateTestSessionRequest>()
            call.respond(TestSessionService.update(principal.tenantId, id, request))
        }
        get("/{id}/tests") {
            val principal = call.tmsPrincipal()
            val id = UUID.fromString(call.parameters["id"])
            call.respond(TestResultService.listBySession(principal.tenantId, id))
        }
    }
}
