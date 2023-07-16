import Browserify from 'browserify';
import fs from 'fs';
import babelify from 'babelify';

let bundler = Browserify({ 
    standalone: 'LocalMedia',
    entries: './localmedia.js'
})

bundler
    .transform(babelify.configure({
        presets : ["@babel/preset-env"]
    }))
    .bundle((err, src) => {
        if(err) {
            console.log('[error]', err);
            return;
        }
        if(src) {
            console.log("Bundling Ok")
        }
    })
    .pipe(fs.createWriteStream('localMedia.bundle.js'));
