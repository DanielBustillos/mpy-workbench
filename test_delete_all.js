// Test script para probar deleteAllInPath
const { deleteAllInPath } = require('./out/src/mpremote');

async function test() {
    try {
        console.log('Testing deleteAllInPath...');
        const result = await deleteAllInPath('/');
        console.log('Result:', result);
        console.log(`Deleted: ${result.deleted.length} items`);
        console.log(`Errors: ${result.errors.length} errors`);
        if (result.deleted.length > 0) {
            console.log('Deleted items:', result.deleted);
        }
        if (result.errors.length > 0) {
            console.log('Errors:', result.errors);
        }
    } catch (error) {
        console.error('Test failed:', error);
    }
}

test();
