'use strict';

var Promise = typeof Promise === 'undefined' ? require('promise') : this.Promise;

/** 
 * The daemon interface interacts with the coin daemon by using the rpc interface.
 * in order to make it work it needs, as constructor, an array of objects containing
 * - 'host'    : hostname where the coin lives
 * - 'port'    : port where the coin accepts rpc connections
 * - 'user'    : username of the coin for the rpc interface
 * - 'password': password for the rpc interface of the coin
**/

var http = require('http');
var cp = require('child_process');
var EventEmitter = require('events').EventEmitter;

var async = require('async');

module.exports = Daemon;

function performHttpRequest(instance, jsonData, callback, logger){
    var options = {
        hostname: (typeof(instance.host) === 'undefined' ? '127.0.0.1' : instance.host),
        port    : instance.port,
        method  : 'POST',
        auth    : instance.user + ':' + instance.password,
        headers : {
            'Content-Length': jsonData.length
        }
    };

    var parseJson = function(res, data){
        var dataJson;

        if (res.statusCode === 401){
            logger('error', 'Unauthorized RPC access - invalid RPC username or password');
            return;
        }

        try{
            dataJson = JSON.parse(data);
        }
        catch(e){
            if (data.indexOf(':-nan') !== -1){
                data = data.replace(/:-nan,/g, ":0");
                parseJson(res, data);
                return;
            }
            logger('error', 'Could not parse rpc data from daemon instance  ' + instance.index
                + '\nRequest Data: ' + jsonData
                + '\nReponse Data: ' + data);

        }
        if (dataJson)
            callback(dataJson.error, dataJson, data);
    };

    var req = http.request(options, function(res) {
        var data = '';
        res.setEncoding('utf8');
        res.on('data', function (chunk) {
            data += chunk;
        });
        res.on('end', function(){
            parseJson(res, data);
        });
    });

    req.on('error', function(e) {
        if (e.code === 'ECONNREFUSED')
            callback({type: 'offline', message: e.message}, null);
        else
            callback({type: 'request error', message: e.message}, null);
    });

    req.end(jsonData);
}

function Daemon(daemons, logger){
    var _this = this;

    this.logger = logger || function(severity, message) {
        console.log(severity + ': ' + message);
    };

    if (!Array.isArray(daemons)) {
        daemons = [daemons]
    }

    var instances = daemons.map(function(daemon, index) {
        daemon.index = index;
        return daemon;
    });

    this.instances = instances;
}

Daemon.prototype = new EventEmitter();


/**
 * Sends a JSON RPC (http://json-rpc.org/wiki/specification) command to every configured daemon.
 * The callback function is fired once with the result from each daemon unless streamResults is
 * set to true.
 */
Daemon.prototype.cmd = function cmd(method, params, callback, streamResults, returnRawData){
    var results = [];
    var self = this;

    async.each(this.instances, function(instance, eachCallback) {
        var itemFinished = function(error, result, data) {
            var returnObj = {
                error: error,
                response: (result || {}).result,
                instance: instance
            };

            if (returnRawData) {
                returnObj.data = data;
            }
            
            if (streamResults) {
                callback(returnObj);
            } else {
                results.push(returnObj);
            }
            eachCallback();
            itemFinished = function(){};
        };

        var requestJson = JSON.stringify({
            method: method,
            params: params,
            id: Date.now() + Math.floor(Math.random() * 10)
        });

        performHttpRequest(instance, requestJson, function(error, result, data){
            itemFinished(error, result, data);
        }, self.logger);
    }, function(){
        if (!streamResults){
            callback(results);
        }
    });
};

/**
 * Performs a batch JSON-RPC command - only uses the first configured rpc daemon
 * First argument must have:
 * [
 *    [ methodName, [params] ],
 *    [ methodName, [params] ]
 * ]
 */
Daemon.prototype.batchCmd = function batchCmd(cmdArray, callback) {
    var requestJson = [];

    for (var i = 0; i < cmdArray.length; i++){
        requestJson.push({
            method: cmdArray[i][0],
            params: cmdArray[i][1],
            id: Date.now() + Math.floor(Math.random() * 10) + i
        });
    }

    var serializedRequest = JSON.stringify(requestJson);

    performHttpRequest(this.instances[0], serializedRequest, function(error, result){
        callback(error, result);
    }, self);
};

Daemon.prototype.isOnline = function () {
    return this.cmd('getinfo', [], function(results){
        var allOnline = results.every(function(result){
            return !results.error;
        });
        callback(allOnline);
        if (!allOnline)
            _this.emit('connectionFailed', results);
    });
};

Daemon.prototype.init = function (callback) {
    this.isOnline(function(online){
        if (online) {
            _this.emit('online');
            callback();
        }
    });
};

Daemon.prototype.pCmd = function (method, params, streamResults, returnRawData) {
    var self = this;
    return new Promise(function (resolve, reject) {
        return self.cmd(method, params, function (data) {
            resolve(data);
        }, streamResults, returnRawData);
    });
};
