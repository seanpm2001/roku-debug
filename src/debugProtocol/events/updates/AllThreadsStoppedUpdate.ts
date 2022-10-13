import { SmartBuffer } from 'smart-buffer';
import type { StopReasonCode } from '../../Constants';
import { ErrorCode, UpdateType } from '../../Constants';
import { util } from '../../../util';
import { protocolUtils } from '../../ProtocolUtil';
import type { ProtocolUpdate } from '../ProtocolEvent';

/**
 * All threads are stopped and an ALL_THREADS_STOPPED message is sent to the debugging client.
 *
 * The data field includes information on why the threads were stopped.
 */
export class AllThreadsStoppedUpdate implements ProtocolUpdate {

    public static fromJson(data: {
        threadIndex: number;
        stopReason: number;
        stopReasonDetail: string;
    }) {
        const update = new AllThreadsStoppedUpdate();
        protocolUtils.loadJson(update, data);
        return update;
    }

    public static fromBuffer(buffer: Buffer) {
        const update = new AllThreadsStoppedUpdate();
        protocolUtils.bufferLoaderHelper(update, buffer, 16, (smartBuffer) => {
            protocolUtils.loadCommonUpdateFields(update, smartBuffer, update.data.updateType);

            update.data.threadIndex = smartBuffer.readInt32LE();
            update.data.stopReason = smartBuffer.readUInt8();
            update.data.stopReasonDetail = protocolUtils.readStringNT(smartBuffer);
        });
        return update;
    }

    public toBuffer() {
        let smartBuffer = new SmartBuffer();

        smartBuffer.writeInt32LE(this.data.threadIndex); // primary_thread_index
        smartBuffer.writeUInt8(this.data.stopReason); // stop_reason
        smartBuffer.writeStringNT(this.data.stopReasonDetail); //stop_reason_detail

        protocolUtils.insertCommonUpdateFields(this, smartBuffer);
        return smartBuffer.toBuffer();
    }

    public success = false;

    public readOffset = -1;

    public data = {
        /**
         * The index of the primary thread that triggered the stop
         */
        threadIndex: undefined as number,
        stopReason: undefined as StopReasonCode,
        stopReasonDetail: undefined as string,

        //common props
        packetLength: undefined as number,
        requestId: 0, //all updates have requestId === 0
        errorCode: ErrorCode.OK,
        updateType: UpdateType.AllThreadsStopped
    };
}
