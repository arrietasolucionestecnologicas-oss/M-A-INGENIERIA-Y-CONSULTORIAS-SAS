package com.michael.tms.service

import com.michael.tms.db.Tenants
import com.michael.tms.db.TestResults
import com.michael.tms.db.TestSessions
import com.michael.tms.db.Users
import com.michael.tms.db.toEntityId
import com.michael.tms.model.InsulationCalculatedResults
import com.michael.tms.model.InsulationRawReadings
import com.michael.tms.model.SubmitInsulationRequest
import com.michael.tms.model.SubmitTtrRequest
import com.michael.tms.model.SubmitWindingResistanceRequest
import com.michael.tms.model.TestResultResponse
import com.michael.tms.model.TestType
import com.michael.tms.model.TestVerdict
import com.michael.tms.model.TtrCalculatedResults
import com.michael.tms.model.TtrRawReadings
import com.michael.tms.model.WindingResistanceCalculatedResults
import com.michael.tms.model.WindingResistanceRawReadings
import com.michael.tms.model.toJsonElement
import com.michael.tms.security.NotFoundException
import com.michael.tms.service.calc.InsulationCalculator
import com.michael.tms.service.calc.TransformerCalcContext
import com.michael.tms.service.calc.TtrCalculator
import com.michael.tms.service.calc.WindingResistanceCalculator
import org.jetbrains.exposed.sql.ResultRow
import org.jetbrains.exposed.sql.and
import org.jetbrains.exposed.sql.eq
import org.jetbrains.exposed.sql.insertAndGetId
import org.jetbrains.exposed.sql.selectAll
import org.jetbrains.exposed.sql.transactions.transaction
import java.time.LocalDateTime
import java.util.UUID
import kotlinx.serialization.json.JsonElement

/**
 * Cálculo siempre en servidor: el cliente (web/móvil) nunca envía resultados calculados,
 * solo lecturas crudas. Cada resultado persistido es inmutable en cuanto a los valores
 * teóricos aplicados (ver TtrCalculator), independientemente de cambios posteriores en el
 * perfil del transformador.
 */
object TestResultService {

    fun submitTtr(tenantId: UUID, sessionId: UUID, request: SubmitTtrRequest, actorId: UUID): TestResultResponse = transaction {
        val ctx = loadTransformerContext(tenantId, sessionId)
        val calculated = TtrCalculator.calculate(ctx, request.readings)
        persist(
            tenantId, sessionId, TestType.TTR,
            request.readings.toJsonElement(TtrRawReadings.serializer()),
            calculated.toJsonElement(TtrCalculatedResults.serializer()),
            TestVerdict.valueOf(calculated.overallVerdict),
            request.instrumentUsed, actorId
        )
    }

    fun submitWindingResistance(tenantId: UUID, sessionId: UUID, request: SubmitWindingResistanceRequest, actorId: UUID): TestResultResponse = transaction {
        loadTransformerContext(tenantId, sessionId) // valida existencia de sesión/transformador
        val calculated = WindingResistanceCalculator.calculate(request.readings)
        persist(
            tenantId, sessionId, TestType.RESISTENCIA_DEVANADOS,
            request.readings.toJsonElement(WindingResistanceRawReadings.serializer()),
            calculated.toJsonElement(WindingResistanceCalculatedResults.serializer()),
            TestVerdict.valueOf(calculated.overallVerdict),
            request.instrumentUsed, actorId
        )
    }

    fun submitInsulation(tenantId: UUID, sessionId: UUID, request: SubmitInsulationRequest, actorId: UUID): TestResultResponse = transaction {
        loadTransformerContext(tenantId, sessionId)
        val calculated = InsulationCalculator.calculate(request.readings)
        persist(
            tenantId, sessionId, TestType.AISLAMIENTO,
            request.readings.toJsonElement(InsulationRawReadings.serializer()),
            calculated.toJsonElement(InsulationCalculatedResults.serializer()),
            TestVerdict.valueOf(calculated.overallVerdict),
            request.instrumentUsed, actorId
        )
    }

    fun listBySession(tenantId: UUID, sessionId: UUID): List<TestResultResponse> = transaction {
        TestSessionService.fetchRow(tenantId, sessionId)
        TestResults.selectAll()
            .where { (TestResults.tenantId eq tenantId) and (TestResults.testSessionId eq sessionId) }
            .map { toResponse(it) }
    }

    fun get(tenantId: UUID, id: UUID): TestResultResponse = transaction {
        toResponse(fetchRow(tenantId, id))
    }

    private fun loadTransformerContext(tenantId: UUID, sessionId: UUID): TransformerCalcContext {
        val session = TestSessionService.fetchRow(tenantId, sessionId)
        val transformerId = session[TestSessions.transformerId].value
        val transformerRow = TransformerService.fetchRow(tenantId, transformerId)
        return TransformerService.toCalcContext(transformerRow)
    }

    private fun persist(
        tenantId: UUID,
        sessionId: UUID,
        testType: TestType,
        rawJson: JsonElement,
        calculatedJson: JsonElement,
        verdict: TestVerdict,
        instrumentUsed: String?,
        actorId: UUID
    ): TestResultResponse {
        val id = TestResults.insertAndGetId {
            it[TestResults.tenantId] = tenantId.toEntityId(Tenants)
            it[TestResults.testSessionId] = sessionId.toEntityId(TestSessions)
            it[TestResults.testType] = testType.name
            it[rawReadings] = rawJson
            it[calculatedResults] = calculatedJson
            it[TestResults.verdict] = verdict.name
            it[instrumentUsed] = instrumentUsed
            it[testedBy] = actorId.toEntityId(Users)
            it[createdAt] = LocalDateTime.now()
        }
        return toResponse(fetchRow(tenantId, id.value))
    }

    private fun fetchRow(tenantId: UUID, id: UUID): ResultRow =
        TestResults.selectAll().where { (TestResults.tenantId eq tenantId) and (TestResults.id eq id) }.singleOrNull()
            ?: throw NotFoundException("Resultado de prueba no encontrado: $id")

    private fun toResponse(row: ResultRow) = TestResultResponse(
        id = row[TestResults.id].value.toString(),
        testSessionId = row[TestResults.testSessionId].value.toString(),
        testType = row[TestResults.testType],
        rawReadings = row[TestResults.rawReadings],
        calculatedResults = row[TestResults.calculatedResults],
        verdict = row[TestResults.verdict],
        instrumentUsed = row[TestResults.instrumentUsed],
        testedBy = row[TestResults.testedBy].value.toString(),
        createdAt = row[TestResults.createdAt].iso()
    )
}
