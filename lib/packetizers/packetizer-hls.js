'use strict';

var Packetizer = require('./packetizer');
var crc32 = require('../utils/crc32');
var util = require('util');

var VideoSample = require('../video-sample');
var AudioSample = require('../audio-sample');
var ExtraParserAac = require('../extra-parsers/extra-parser-aac');
var ExtraParserH264 = require('../extra-parsers/extra-parser-h264');

var SYNC_BYTE = 0x47;
var PACKET_SIZE = 188;
var VIDEO_PID = 258;
var AUDIO_PID = 259;
var PMP_PID = 4095;
var AUDIO_SAMPLES_PACK = 5;
var MAX_PAYLOAD_SIZE = 32725;

function PacketizerHls() {
    Packetizer.apply(this, Array.prototype.slice.call(arguments));

    this._lastVideoSampleTime = -1;
    this._lastAudioSampleTime = -1;
    this._lastSampleTime = -1;
    this._audioCounter = 0;
    this._videoCounter = 0;
    this._videoExtraParser = null;
}

util.inherits(PacketizerHls, Packetizer);

PacketizerHls.prototype.packetize = function() {
    return this._fragment.read().then(function() {
        var buffers = [];
        var buffersLength = 0;

        // Write header
        var header = this._buildHeader();
        buffers.push(header);
        buffersLength += header.length;

        // Parse codec extra data
        if (this.videoExtraData().length > 0) {
            this._videoExtraParser = new ExtraParserH264(this.videoExtraData());
        }
        var audioExtraParser = null;
        if (this.audioExtraData().length > 0) {
            audioExtraParser = new ExtraParserAac(this.audioExtraData());
        }

        this._lastVideoSampleTime = -1;
        this._lastAudioSampleTime = -1;
        this._lastSampleTime = -1;
        this._audioCounter = 0;
        this._videoCounter = 0;

        var audioPayloadSamplesCount = 0;
        var audioPayloadSampleTime = 0;
        var audioPayloadSample = null;
        var audioPayloads = [];
        var audioPayloadsLength = 0;

        var index = 0;
        var samples = this.samples();
        for (var i = 0, l = samples.length; i < l; i++) {
            var sample = samples[i];
            var packetSize = sample.buffer().readInt32BE(0) + 4;
            var packet = sample.buffer();
            var sampleTime = (90 * sample.timestamp() * this._fragment.timescale()) << 0;

            if (sample instanceof AudioSample) {
                this._lastAudioSampleTime = sampleTime;

                if (0 === audioPayloadSamplesCount) {
                    audioPayloadSampleTime = sampleTime;
                    audioPayloadSample = sample;
                }
                var partPayload = new Buffer(7 + packet.length);
                var size = partPayload.length;

                partPayload[0] = 0xff;
                partPayload[1] = 0xf1;
                partPayload[2] = ((((audioExtraParser.profileObjectType() - 1) & 0x3) << 6)
                    + ((audioExtraParser.rateIndex() << 2) & 0x3c)
                    + ((audioExtraParser.channelsIndex() >> 2) & 0x1)) & 0xff;
                partPayload[3] = ((audioExtraParser.channelsIndex() & 0x3) << 6) & 0xff;
                partPayload[5] = (((size & 0x7) << 5) + 0x5) & 0xff;
                size >>= 3;
                partPayload[4] = size & 0xff;
                size >>= 8;
                partPayload[3] += size & 0x3;
                partPayload[6] = 0xffc;

                packet.copy(partPayload, 7);
                audioPayloads.push(partPayload);
                audioPayloadsLength += partPayload.length;
                audioPayloadSamplesCount++;

                if ((audioPayloadSamplesCount === AUDIO_SAMPLES_PACK) && audioPayloadsLength > 0) {
                    var audioBuffer = this._packAudioPayload(Buffer.concat(audioPayloads, audioPayloadsLength), audioPayloadSample, audioPayloadSampleTime);
                    buffers.push(audioBuffer);
                    buffersLength += audioBuffer.length;
                    audioPayloadSamplesCount = 0;
                    audioPayloads = [];
                    audioPayloadsLength = 0;
                }
            } else if (sample instanceof VideoSample) {
                this._lastVideoSampleTime = sampleTime;

                var sampleCompTime = (90 * sample.compositionOffset() * this._fragment.timescale() / sample.timescale()) << 0;
                var resTime = sampleTime + sampleCompTime;

                // Fix sample
                if (packetSize < packet.length) {
                    packet[packetSize] = 0;
                    packet[packetSize + 1] = 0;
                    packet[packetSize + 2] = 0;
                    packet[packetSize + 3] = 1;
                }

                var bufConfig = sample.keyframe() ? this._videoConfig() : new Buffer(0);

                // Build new packet
                var newPacket = new Buffer(6 + packet.length + bufConfig.length);
                var newPos = 0;
                newPacket[newPos++] = 0;
                newPacket[newPos++] = 0;
                newPacket[newPos++] = 0;
                newPacket[newPos++] = 0x1;
                newPacket[newPos++] = 0x9;
                newPacket[newPos++] = sample.keyframe() ? 0x10 : 0x30;

                if (bufConfig.length > 0) {
                    bufConfig.copy(newPacket, newPos);
                    newPos += bufConfig.length;
                }
                newPacket[newPos++] = 0;
                newPacket[newPos++] = 0;
                newPacket[newPos++] = 0;
                newPacket[newPos++] = 0x1;
                packet.copy(newPacket, newPos, 4);
                packet = newPacket;

                var packetPos = 0;
                do {
                    var chunkLength = Math.min(MAX_PAYLOAD_SIZE, packet.length - packetPos);

                    // Build payload from sample
                    var payload = new Buffer(19 + chunkLength);
                    var pos = 0;

                    var pesPacketLength = (13 + chunkLength) & 0xff;

                    payload[pos++] = 0; // packet_start_code_prefix
                    payload[pos++] = 0; // packet_start_code_prefix
                    payload[pos++] = 1; // packet_start_code_prefix
                    payload[pos++] = 0xe0; // stream_id
                    payload[pos++] = (pesPacketLength >> 8) & 0xff; // PES_packet_length
                    payload[pos++] = (pesPacketLength) & 0xff; // PES_packet_length
                    payload[pos++] = 0 === packetPos ? 0x84 : 0x80;
                    payload[pos++] = 0xc0;
                    payload[pos++] = 10;

                    // PTS_DTS
                    this._writeTime(payload, pos, resTime);
                    pos += 5;
                    this._writeTime(payload, pos, sampleTime);
                    pos += 5;

                    packet.copy(payload, pos, packetPos, packetPos + chunkLength);

                    var packerBuffer = this._packPayload(payload, sample, VIDEO_PID);
                    buffers.push(packerBuffer);
                    buffersLength += packerBuffer.length;

                    packetPos += chunkLength;
                } while (packetPos < packet.length);
            }
            index++;
        }

        // Latest audio payload
        if (audioPayloadsLength > 0) {
            var lastAudioBuffer = this._packAudioPayload(Buffer.concat(audioPayloads, audioPayloadsLength), audioPayloadSample, audioPayloadSampleTime);
            buffers.push(lastAudioBuffer);
            buffersLength += lastAudioBuffer.length;
        }

        return Buffer.concat(buffers, buffersLength);
    }.bind(this));
};

PacketizerHls.prototype._packAudioPayload = function(payload, sample, time) {
    // Build payload from sample
    var data = new Buffer(14 + payload.length);
    var pos = 0;

    var pesPacketLength = 8 + payload.length;

    data[pos++] = 0; // packet_start_code_prefix
    data[pos++] = 0; // packet_start_code_prefix
    data[pos++] = 1; // packet_start_code_prefix
    data[pos++] = 0xc0; // stream_id
    data[pos++] = (pesPacketLength >> 8) & 0xff; // PES_packet_length
    data[pos++] = pesPacketLength & 0xff; // PES_packet_length
    data[pos++] = 0x80;
    data[pos++] = 0x80;
    data[pos++] = 5;

    // PTS_DTS
    this._writeTime(data, pos, time);
    pos += 5;

    // Copy payload to data
    payload.copy(data, pos);

    // Pack payload
    return this._packPayload(data, sample, AUDIO_PID);
};

PacketizerHls.prototype._packPayload = function(payload, sample, pid) {
    var packetIndex = 0;
    var payloadPos = 0;
    var buffers = [];
    var buffersLength = 0;
    while (payloadPos < payload.length) {
        var lastBytes = payload.length - payloadPos;
        var adaptationFields = false;
        if ((sample instanceof VideoSample && 0 === packetIndex) || lastBytes < PACKET_SIZE - 4) {
            adaptationFields = true;
        }

        // Build packet
        var bufPacket = new Buffer(PACKET_SIZE);
        bufPacket[0] = SYNC_BYTE;
        bufPacket[1] = 0;
        if (0 === packetIndex) {
            bufPacket[1] = 0x40;
        }
        bufPacket[1] += (pid >> 8) & 0x1f;
        bufPacket[2] = pid & 0xff;
        bufPacket[3] = adaptationFields ? 0x30 : 0x10;
        if (sample instanceof AudioSample) {
            bufPacket[3] += this._audioCounter & 0xf;
            this._audioCounter++;
        } else if (sample instanceof VideoSample) {
            bufPacket[3] += this._videoCounter & 0xf;
            this._videoCounter++;
        }
        var pos = 4;
        if (adaptationFields) {
            var adaptationLength = 0;
            if (sample instanceof VideoSample && 0 === packetIndex) {
                adaptationLength = 7;
            }
            if (lastBytes < PACKET_SIZE - 5) {
                adaptationLength = Math.max(adaptationLength, PACKET_SIZE - 5 - lastBytes);
            }
            bufPacket[pos++] = adaptationLength;
            if (0 < adaptationLength) {
                var usedAdaptationLength = 1;
                var adaptationFlags = 0;
                if (sample instanceof VideoSample && 0 === packetIndex && sample.keyframe()) {
                    adaptationFlags = 0x40;
                }
                if (sample instanceof VideoSample && 0 === packetIndex) {
                    adaptationFlags += 0x10;
                    usedAdaptationLength += 6;
                    var time = this._pcrTimecode();
                    bufPacket[pos + 6] = 0;
                    bufPacket[pos + 5] = ((time & 0x1) << 7) | 0x7e;
                    time >>= 1;
                    bufPacket[pos + 4] = time & 0xff;
                    time >>= 8;
                    bufPacket[pos + 3] = time & 0xff;
                    time >>= 8;
                    bufPacket[pos + 2] = time & 0xff;
                    time >>= 8;
                    bufPacket[pos + 1] = time & 0xff;
                }
                bufPacket[pos] = adaptationFlags;
                pos += usedAdaptationLength;
                if (usedAdaptationLength < adaptationLength) {
                    bufPacket.fill(-1, pos, pos + adaptationLength - usedAdaptationLength);
                    pos += adaptationLength - usedAdaptationLength;
                }
            }
        }

        var bufCapacity = bufPacket.length - pos;
        if (0 < bufCapacity) {
            payload.copy(bufPacket, pos, payloadPos, payloadPos + bufCapacity);
            payloadPos += bufCapacity;
        }

        packetIndex++;
        buffers.push(bufPacket);
        buffersLength += bufPacket.length;
    }
    return Buffer.concat(buffers, buffersLength);
};

PacketizerHls.prototype._buildHeader = function() {
    var headerBuf = new Buffer(2 * PACKET_SIZE);
    var headerPos = 0;

    // Write PAM packet
    headerBuf[headerPos++] = SYNC_BYTE;
    headerBuf[headerPos++] = 0x40;
    headerBuf[headerPos++] = 0;
    headerBuf[headerPos++] = 0x10;
    headerBuf[headerPos++] = 0;

    var sectionLength = 13;

    var mapBuf = new Buffer(12);
    var mapPos = 0;
    mapBuf[mapPos++] = 0;
    mapBuf[mapPos++] = ((sectionLength >> 8) & 0x0f) + 0xb0;
    mapBuf[mapPos++] = sectionLength & 0xff;
    mapBuf[mapPos++] = 0;
    mapBuf[mapPos++] = 1;
    mapBuf[mapPos++] = 0xc1;
    mapBuf[mapPos++] = 0;
    mapBuf[mapPos++] = 0;
    mapBuf[mapPos++] = 0;
    mapBuf[mapPos++] = 1;
    mapBuf[mapPos++] = ((PMP_PID >> 8) & 0x1f) + 0xe0;
    mapBuf[mapPos++] = PMP_PID & 0xff;
    mapBuf.copy(headerBuf, headerPos);
    headerPos += mapBuf.length;
    headerBuf.writeInt32BE(crc32.checksum(mapBuf), headerPos);
    headerPos += 4;

    if (headerPos < PACKET_SIZE) {
        var emptyBuf = new Buffer(PACKET_SIZE - headerPos);
        emptyBuf.fill(-1);
        emptyBuf.copy(headerBuf, headerPos);
        headerPos += emptyBuf.length;
    }

    // Write PAM packet
    headerBuf[headerPos++] = SYNC_BYTE;
    headerBuf[headerPos++] = ((PMP_PID >> 8) & 0x1f) + 0x40;
    headerBuf[headerPos++] = PMP_PID & 0xff;
    headerBuf[headerPos++] = 0x10;
    headerBuf[headerPos++] = 0;

    sectionLength = 18 + (this.audioExtraData() ? 5 : 0);
    mapBuf = new Buffer(17 + (this.audioExtraData() ? 5 : 0));
    mapPos = 0;
    mapBuf[mapPos++] = 2;
    mapBuf[mapPos++] = ((sectionLength >> 8) & 0x0f) + 0xb0;
    mapBuf[mapPos++] = sectionLength & 0xff;
    mapBuf[mapPos++] = 0;
    mapBuf[mapPos++] = 1;
    mapBuf[mapPos++] = 0xc1;
    mapBuf[mapPos++] = 0;
    mapBuf[mapPos++] = 0;
    mapBuf[mapPos++] = ((VIDEO_PID >> 8) & 0x1f) + 0xe0;
    mapBuf[mapPos++] = VIDEO_PID & 0xff;
    mapBuf[mapPos++] = 0xf0;
    mapBuf[mapPos++] = 0;

    // Video data
    mapBuf[mapPos++] = 0x1b;
    mapBuf[mapPos++] = ((VIDEO_PID >> 8) & 0x1f) + 0xe0;
    mapBuf[mapPos++] = VIDEO_PID & 0xff;
    mapBuf[mapPos++] = 0xf0;
    mapBuf[mapPos++] = 0;

    // Audio data
    if (this.audioExtraData().length > 0) {
        mapBuf[mapPos++] = 0x0f;
        mapBuf[mapPos++] = ((AUDIO_PID >> 8) & 0x1f) + 0xe0;
        mapBuf[mapPos++] = AUDIO_PID & 0xff;
        mapBuf[mapPos++] = 0xf0;
        mapBuf[mapPos++] = 0;
    }

    mapBuf.copy(headerBuf, headerPos);
    headerPos += mapBuf.length;
    headerBuf.writeInt32BE(crc32.checksum(mapBuf), headerPos);
    headerPos += 4;

    if (headerPos < 2 * PACKET_SIZE) {
        headerBuf.fill(-1, headerPos);
    }

    return headerBuf;
};

PacketizerHls.prototype._pcrTimecode = function() {
    var sampleTime = -1;
    if (this._lastVideoSampleTime >= 0 && this._lastAudioSampleTime >= 0) {
        sampleTime = Math.min(this._lastVideoSampleTime, this._lastAudioSampleTime);
    } else if (this._lastAudioSampleTime >= 0) {
        sampleTime = this._lastAudioSampleTime;
    } else if (this._lastVideoSampleTime >= 0) {
        sampleTime = this._lastVideoSampleTime;
    }
    if (this._lastSampleTime !== -1 && sampleTime < this._lastSampleTime) {
        sampleTime = this._lastSampleTime;
    }
    if (sampleTime < 0) {
        sampleTime = 0;
    }
    this._lastSampleTime = sampleTime;
    return sampleTime;
};

PacketizerHls.prototype._videoConfig = function() {
    var sets = this._videoExtraParser.sps().concat(this._videoExtraParser.pps());
    var data = new Buffer(this._videoExtraParser.spsLength() + this._videoExtraParser.ppsLength() + 4 * sets.length);
    var pos = 0;
    for (var i = 0, l = sets.length; i < l; i++) {
        data[pos++] = 0;
        data[pos++] = 0;
        data[pos++] = 0;
        data[pos++] = 0x1;
        sets[i].copy(data, pos);
        pos += sets[i].length;
    }
    return data;
};

PacketizerHls.prototype._writeTime = function(buffer, pos, time) {
    buffer[pos + 4] = ((time & 0x7f) << 1) + 0x1;
    time >>= 7;
    buffer[pos + 3] = time & 0xff;
    time >>= 8;
    buffer[pos + 2] = ((time & 0x7f) << 1) + 0x1;
    time >>= 7;
    buffer[pos + 1] = time & 0xff;
    time >>= 8;
    buffer[pos + 0] = ((time & 0x7) << 1) + 0x21;
};

module.exports = PacketizerHls;