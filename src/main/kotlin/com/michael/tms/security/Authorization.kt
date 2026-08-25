package com.michael.tms.security

import com.michael.tms.model.UserRole
import io.ktor.server.application.ApplicationCall
import io.ktor.server.auth.authentication
import io.ktor.server.auth.principal

fun ApplicationCall.tmsPrincipal(): TmsPrincipal =
    principal<TmsPrincipal>() ?: throw ForbiddenException("No autenticado")

fun ApplicationCall.requireRole(vararg allowed: UserRole): TmsPrincipal {
    val principal = tmsPrincipal()
    if (principal.role !in allowed) {
        throw ForbiddenException("El rol ${principal.role} no está autorizado para esta operación")
    }
    return principal
}
