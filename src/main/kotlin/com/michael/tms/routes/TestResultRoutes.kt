package com.michael.tms.routes

import com.michael.tms.model.SubmitInsulationRequest
import com.michael.tms.model.SubmitTtrRequest
import com.michael.tms.model.SubmitWindingResistanceRequest
import com.michael.tms.security.tmsPrincipal
import com.michael.tms.service.TestResultService
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.call
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.route
import java.util.UUID

fun Route.testResultRoutes() {
    route("/test-sessions/{sessionId}/tests") {
        post("/ttr") {
            val principal = call.tmsPrincipal()
            val sessionId = UUID.fromString(call.parameters["sessionId"])
            val request = call.receive<SubmitTtrRequest>()
            call.respond(
                HttpStatusCode.Created,
                TestResultService.submitTtr(principal.tenantId, sessionId, request, principal.userId)
            )
        }
        post("/resistencia-devanados") {
            val principal = call.tmsPrincipal()
            val sessionId = UUID.fromString(call.parameters["sessionId"])
            val request = call.receive<SubmitWindingResistanceRequest>()
            call.respond(
                HttpStatusCode.Created,
                TestResultService.submitWindingResistance(principal.tenantId, sessionId, request, principal.userId)
            )
        }
        post("/aislamiento") {
            val principal = call.tmsPrincipal()
            val sessionId = UUID.fromString(call.parameters["sessionId"])
            val request = call.receive<SubmitInsulationRequest>()
            call.respond(
                HttpStatusCode.Created,
                TestResultService.submitInsulation(principal.tenantId, sessionId, request, principal.userId)
            )
        }
    }

    route("/tests/{id}") {
        get {
            val principal = call.tmsPrincipal()
            val id = UUID.fromString(call.parameters["id"])
            call.respond(TestResultService.get(principal.tenantId, id))
        }
    }
}
