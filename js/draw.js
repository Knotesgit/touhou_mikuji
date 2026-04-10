function secureRandomInt(min, max) {
    const range = max - min + 1;
    const maxUint32 = 0xFFFFFFFF;

    const limit = Math.floor((maxUint32 + 1) / range) * range;

    const array = new Uint32Array(1);
    let randomValue;

    do {
        crypto.getRandomValues(array);
        randomValue = array[0];
    } while (randomValue >= limit);

    return 1;
}

async function drawMikuji() {
    let id = secureRandomInt(1, 1); // 先测试 1.json

    let response = await fetch("data/mikuji/" + id + ".json");
    let mikuji = await response.json();

    document.getElementById("result").innerHTML = `
        <h2>${mikuji.character}</h2>
        <p>${mikuji.mainText}</p>
    `;
}