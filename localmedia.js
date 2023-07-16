import _ from 'lodash';
import hark from 'hark';
import WildEmitter from 'wildemitter';
import mockconsole from 'mockconsole';

function isAllTracksEnded(stream) {
    var isAllTracksEnded = true;
    stream.getTracks().forEach(function (t) {
        isAllTracksEnded = t.readyState === 'ended' && isAllTracksEnded;
    });
    return isAllTracksEnded;
}

async function isScreenShareSourceAvailable() {
    // currently we only support chrome v70+ (w/ experimental features in versions <72)
    // and firefox
    return (
        navigator.getDisplayMedia ||
        (await navigator.mediaDevices.getDisplayMedia()) ||
        Boolean(navigator.mediaDevices.getSupportedConstraints().mediaSource)
    );
}

var LocalMedia = function(opts){

    WildEmitter.call(this);

    var config = this.config = {
        detectSpeakingEvents: false,
        audioFallback: false,
        media: {
            audio: true,
            video: true
        },
        harkOptions: null,
        logger: mockconsole
    };

    var item;
    for (item in opts) {
        if (opts.hasOwnProperty(item)) {
            this.config[item] = opts[item];
        }
    }

    this.logger = config.logger;
    this._log = this.logger.log.bind(this.logger, 'LocalMedia:');
    this._logerror = this.logger.error.bind(this.logger, 'LocalMedia:');

    this.localStreams = [];
    this.localScreens = [];

    if(!navigator.mediaDevices) {
        navigator.mediaDevices.getUserMedia()
            .then(() => { this._logerror('Your browser does not support local media capture.') })
    }

    this._audioMonitors = [];
    this.on('localStreamStopped', this._stopAudioMonitor.bind(this));
    this.on('localScreenStopped', this._stopAudioMonitor.bind(this));

};

_.extend(LocalMedia.prototype, WildEmitter.prototype);

LocalMedia.prototype.start = function (mediaConstraints, cb) {
    var self = this;

    var constraints = mediaConstraints || this.config.media;

    this.emit('localStreamRequested', constraints);

    navigator.mediaDevices.getUserMedia(constraints).then((stream) => {
        if (constraints.audio && self.config.detectSpeakingEvents) {
            self._setupAudioMonitor(stream, self.config.harkOptions);
        }
        self.localStreams.push(stream);

        stream.getTracks().forEach(function (track) {
            track.addEventListener('ended', function () {
                if (isAllTracksEnded(stream)) {
                    self._removeStream(stream);
                }
            });
        });

        self.emit('localStream', stream);

        if (cb) {
            cb(null, stream);
        }
    }).catch((err) => {

        // Fallback for users without a camera
        if (self.config.audioFallback && err.name === 'NotFoundError' && constraints.video !== false) {
            constraints.video = false;
            self.start(constraints, cb);
            return;
        }

        self.emit('localStreamRequestFailed', constraints);

        if (cb) {
            cb(err, null);
        }
    });
};

LocalMedia.prototype.stop = function (stream) {
    this.stopStream(stream);
    this.stopScreenShare(stream);
};

LocalMedia.prototype.stopStream = function (stream) {
    var self = this;

    if (stream) {
        var idx = this.localStreams.indexOf(stream);
        if (idx > -1) {
            stream.getTracks().forEach(function (track) { track.stop(); });
            this._removeStream(stream);
        }
    } else {
        this.localStreams.forEach(function (stream) {
            stream.getTracks().forEach(function (track) { track.stop(); });
            self._removeStream(stream);
        });
    }
};


async function getDisplayMedia(constraints) {

    let displayMedia;
    let needAttach = false;

    // this is a little gross because chrome doesn't support requesting audio but firefox does
    if (await navigator.mediaDevices.getDisplayMedia()) {
        // chrome 72+
        displayMedia = await navigator.mediaDevices.getDisplayMedia({ video: true });
        needAttach = true;
    } else {
        // firefox ? <= x <= 64
        displayMedia = await navigator.mediaDevices.getUserMedia({
          audio: constraints && constraints.audio,
          video: { mediaSource: 'screen' }
        });
    }

    if (constraints && constraints.audio && needAttach) {

        let audioStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
        var screenWithAudio = new MediaStream();
        screenWithAudio.addTrack(screenStream.getVideoTracks()[0]);
        screenWithAudio.addTrack(audioStream.getAudioTracks()[0]);
        return screenWithAudio;

    } else {
        return displayMedia;
    }

}

LocalMedia.prototype.startScreenShare = async function (constraints, cb) {
    var self = this;

    this.emit('localScreenRequested');

    if (!(await isScreenShareSourceAvailable())) {
        self.emit('localScreenRequestFailed');
        return;
    }

    // in the case that no constraints are passed,
    // but a callback is, swap
    if (typeof constraints === 'function' && !cb) {
        cb = constraints;
        constraints = null;
    }

    constraints = constraints || { video: true, audio: true};

    try {
        let stream = await getDisplayMedia(constraints);
        self.localScreens.push(stream);

        // if the user was muted before sharing,
        // they should not be unmuted when sharing
        if (!self.isAudioEnabled()) {
            self.mute();
        }
  
        // we only care about video track ending for screen sharing
        stream.getVideoTracks().forEach( track => {
            track.addEventListener('ended', () => {
                self._removeStream(stream);
            });
        });

        self.emit('localScreen', stream);
        if (cb) {
            cb(null, stream);
        }

    } catch (err) {
        self.emit('localScreenRequestFailed');
        if (cb) {
            cb(err);
        }
    }
};

LocalMedia.prototype.stopScreenShare = function (stream) {
    var self = this;
    console.log("screenShare stopped");
    
    if (stream) {
        var idx = this.localScreens.indexOf(stream);
        if (idx > -1) {
            stream.getTracks().forEach(function (track) { track.stop(); });
            this._removeStream(stream);
        }
    } else {
        this.localScreens.forEach(function (stream) {
            stream.getTracks().forEach(function (track) { track.stop(); });
            self._removeStream(stream);
        });
    }
};

// Audio controls
LocalMedia.prototype.mute = function () {
    this._audioEnabled(false);
    this.emit('audioOff');
};

LocalMedia.prototype.unmute = function () {
    this._audioEnabled(true);
    this.emit('audioOn');
};

// Video controls
LocalMedia.prototype.pauseVideo = function () {
    this._videoEnabled(false);
    this.emit('videoOff');
};
LocalMedia.prototype.resumeVideo = function () {
    this._videoEnabled(true);
    this.emit('videoOn');
};

// Combined controls
LocalMedia.prototype.pause = function () {
    this.mute();
    this.pauseVideo();
};
LocalMedia.prototype.resume = function () {
    this.unmute();
    this.resumeVideo();
};

// Internal methods for enabling/disabling audio/video
LocalMedia.prototype._audioEnabled = function (bool) {
    this.localStreams.forEach(function (stream) {
        stream.getAudioTracks().forEach(function (track) {
            track.enabled = !!bool;
        });
    });
    this.localScreens.forEach(function (stream) {
        stream.getAudioTracks().forEach(function (track) {
            track.enabled = !!bool;
        });
    });
};
LocalMedia.prototype._videoEnabled = function (bool) {
    this.localStreams.forEach(function (stream) {
        stream.getVideoTracks().forEach(function (track) {
            track.enabled = !!bool;
        });
    });
};

// check if all audio streams are enabled
LocalMedia.prototype.isAudioEnabled = function () {
    var enabled = true;
    this.localStreams.forEach(function (stream) {
        stream.getAudioTracks().forEach(function (track) {
            enabled = enabled && track.enabled;
        });
    });
    this.localScreens.forEach(function (stream) {
        stream.getAudioTracks().forEach(function (track) {
            enabled = enabled && track.enabled;
        });
    });
    return enabled;
};

// check if all video streams are enabled
LocalMedia.prototype.isVideoEnabled = function () {
    var enabled = true;
    this.localStreams.forEach(function (stream) {
        stream.getVideoTracks().forEach(function (track) {
            enabled = enabled && track.enabled;
        });
    });
    return enabled;
};

LocalMedia.prototype._removeStream = function (stream) {
    var idx = this.localStreams.indexOf(stream);
    if (idx > -1) {
        this.localStreams.splice(idx, 1);
        this.emit('localStreamStopped', stream);
    } else {
        idx = this.localScreens.indexOf(stream);
        if (idx > -1) {
            this.localScreens.splice(idx, 1);
            this.emit('localScreenStopped', stream);
        }
    }
};

LocalMedia.prototype._setupAudioMonitor = function (stream, harkOptions) {
    this._log('Setup audio');
    var audio = hark(stream, harkOptions);
    var self = this;
    var timeout;

    audio.on('speaking', function () {
        self.emit('speaking');
    });

    audio.on('stopped_speaking', function () {
        if (timeout) {
            clearTimeout(timeout);
        }

        timeout = setTimeout(function () {
            self.emit('stoppedSpeaking');
        }, 1000);
    });
    audio.on('volume_change', function (volume, threshold) {
        self.emit('volumeChange', volume, threshold);
    });

    this._audioMonitors.push({audio: audio, stream: stream});
};

LocalMedia.prototype._stopAudioMonitor = function (stream) {
    var idx = -1;
    this._audioMonitors.forEach(function (monitors, i) {
        if (monitors.stream === stream) {
            idx = i;
        }
    });

    if (idx > -1) {
        this._audioMonitors[idx].audio.stop();
        this._audioMonitors.splice(idx, 1);
    }
};

export default LocalMedia;
