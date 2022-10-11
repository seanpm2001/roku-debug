import { expect } from 'chai';
import { ERROR_CODES, StopReasonCode, UPDATE_TYPES } from '../../Constants';
import { ExecuteV3Response } from './ExecuteV3Response';

describe('ExecuteV3Response', () => {
    it('serializes and deserializes properly', () => {
        const command = ExecuteV3Response.fromJson({
            requestId: 3,
            executeSuccess: true,
            runtimeStopCode: StopReasonCode.Break,
            compileErrors: [
                'compile 1'
            ],
            runtimeErrors: [
                'runtime 1'
            ],
            otherErrors: [
                'other 1'
            ]
        });

        expect(command.data).to.eql({
            packetLength: undefined,
            requestId: 3,
            errorCode: ERROR_CODES.OK,

            executeSuccess: true,
            runtimeStopCode: StopReasonCode.Break,
            compileErrors: [
                'compile 1'
            ],
            runtimeErrors: [
                'runtime 1'
            ],
            otherErrors: [
                'other 1'
            ]
        });

        expect(
            ExecuteV3Response.fromBuffer(command.toBuffer()).data
        ).to.eql({
            packetLength: 54, // 4 bytes
            requestId: 3, // 4 bytes
            errorCode: ERROR_CODES.OK, // 4 bytes

            executeSuccess: true, // 1 byte
            runtimeStopCode: StopReasonCode.Break, // 1 byte

            // num_compile_errors // 4 bytes
            compileErrors: [
                'compile 1' // 10 bytes
            ],
            // num_runtime_errors // 4 bytes
            runtimeErrors: [
                'runtime 1' // 10 bytes
            ],
            // num_other_errors // 4 bytes
            otherErrors: [
                'other 1' // 8 bytes
            ]
        });
    });

    it('Handles zero errors', () => {
        const command = ExecuteV3Response.fromJson({
            requestId: 3,
            executeSuccess: true,
            runtimeStopCode: StopReasonCode.Break,

            compileErrors: [],
            runtimeErrors: [],
            otherErrors: []
        });

        expect(command.data).to.eql({
            packetLength: undefined,
            requestId: 3,
            errorCode: ERROR_CODES.OK,

            executeSuccess: true,
            runtimeStopCode: StopReasonCode.Break,
            compileErrors: [],
            runtimeErrors: [],
            otherErrors: []
        });

        expect(
            ExecuteV3Response.fromBuffer(command.toBuffer()).data
        ).to.eql({
            packetLength: 26, // 4 bytes
            requestId: 3, // 4 bytes
            errorCode: ERROR_CODES.OK, // 4 bytes

            executeSuccess: true, // 1 byte
            runtimeStopCode: StopReasonCode.Break, // 1 byte
            // num_compile_errors // 4 bytes
            compileErrors: [],
            // num_runtime_errors // 4 bytes
            runtimeErrors: [],
            // num_other_errors // 4 bytes
            otherErrors: []
        });
    });
});
