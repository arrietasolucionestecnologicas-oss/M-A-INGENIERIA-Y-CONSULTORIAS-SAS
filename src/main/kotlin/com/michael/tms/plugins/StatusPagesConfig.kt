package com.michael.tms.plugins

import com.michael.tms.model.ErrorResponse
import com.michael.tms.security.BadRequestException
import com.michael.tms.security.ConflictException
import com.michael.tms.security.ForbiddenException
import com.michael.tms.security.NotFoundException
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.Application
import io.ktor.server.application.install
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.response.respond

fun Application.configureStatusPages() {
    install(StatusPages) {
        exception<NotFoundException> { call, cause ->
            call.respond(HttpStatusCode.NotFound, ErrorResponse(cause.message ?: "No encontrado"))
        }
        exception<BadRequestException> { call, cause ->
            call.respond(HttpStatusCode.BadRequest, ErrorResponse(cause.message ?: "Solicitud inválida"))
        }
        exception<ForbiddenException> { call, cause ->
            call.respond(HttpStatusCode.Forbidden, ErrorResponse(cause.message ?: "No autorizado"))
        }
        exception<ConflictException> { call, cause ->
            call.respond(HttpStatusCode.Conflict, ErrorResponse(cause.message ?: "Conflicto"))
        }
        exception<IllegalArgumentException> { call, cause ->
            call.respond(HttpStatusCode.BadRequest, ErrorResponse(cause.message ?: "Parámetro inválido"))
        }
        exception<Throwable> { call, cause ->
            call.application.environment.log.error("Error no controlado", cause)
            call.respond(HttpStatusCode.InternalServerError, ErrorResponse("Error interno del servidor"))
        }
    }
}
